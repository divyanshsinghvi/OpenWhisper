#!/usr/bin/env python3
"""
Parakeet Unified streaming server.

Captures microphone audio, periodically runs NVIDIA Parakeet Unified's
streaming inference over the rolling buffer, and emits JSON events compatible
with MoonshineStreamingModel.
"""
import json
import os
import queue
import sys
import tempfile
import threading
import time

os.environ.setdefault("MPLCONFIGDIR", os.path.join(os.getcwd(), "temp", "matplotlib"))

import numpy as np
import sounddevice as sd
import soundfile as sf
import torch

import nemo.collections.asr as nemo_asr
from omegaconf import OmegaConf, open_dict

SAMPLE_RATE = 16000
CHANNELS = 1
BLOCK_SIZE = 1600
MODEL_NAME = os.environ.get("PARAKEET_MODEL_NAME", "nvidia/parakeet-tdt-0.6b-v3")
INFER_INTERVAL_SECONDS = float(os.environ.get("PARAKEET_STREAM_INTERVAL_SECONDS", "1.25"))
MIN_AUDIO_SECONDS = float(os.environ.get("PARAKEET_MIN_AUDIO_SECONDS", "0.7"))
MAX_AUDIO_SECONDS = float(os.environ.get("PARAKEET_MAX_AUDIO_SECONDS", "45"))

sys.stdout = open(sys.stdout.fileno(), mode="w", buffering=1, encoding="utf8")


def emit(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def normalize_result(result):
    if not result:
        return ""

    first = result[0]
    return (getattr(first, "text", None) or str(first)).strip()


class ParakeetStreamingServer:
    def __init__(self):
        self.model = None
        self.audio_queue = queue.Queue()
        self.audio_chunks = []
        self.recording = False
        self.stop_event = threading.Event()
        self.worker = None
        self.stream = None
        self.last_text = ""
        self.supports_cache_aware = True

    def load_model(self):
        sys.stderr.write(f"[PARAKEET] Loading model: {MODEL_NAME}\n")
        sys.stderr.flush()
        emit({"status": "loading", "model": MODEL_NAME})

        torch.set_grad_enabled(False)
        self.model = nemo_asr.models.ASRModel.from_pretrained(model_name=MODEL_NAME)
        self.model.eval()

        # Some Parakeet checkpoints ship without a validation_ds in cfg, but
        # NeMo's transcribe pipeline calls cfg.validation_ds.get(...) and crashes
        # with "'NoneType' object has no attribute 'get'". Inject a stub.
        with open_dict(self.model.cfg):
            if self.model.cfg.get("validation_ds") is None:
                self.model.cfg.validation_ds = OmegaConf.create({
                    "use_start_end_token": False,
                    "sample_rate": SAMPLE_RATE,
                    "manifest_filepath": None,
                    "batch_size": 1,
                    "shuffle": False,
                    "num_workers": 0,
                    "pin_memory": False,
                })

        if torch.backends.mps.is_available():
            self.model = self.model.to("mps")
            sys.stderr.write("[PARAKEET] Using MPS device\n")
        else:
            sys.stderr.write("[PARAKEET] Using CPU device\n")

        sys.stderr.write("[PARAKEET] Model loaded, ready.\n")
        sys.stderr.flush()
        emit({"status": "ready"})

    def audio_callback(self, indata, frames, time_info, status):
        if status:
            sys.stderr.write(f"[PARAKEET] Audio status: {status}\n")
            sys.stderr.flush()

        if self.recording:
            self.audio_queue.put(indata.copy())

    def start(self):
        if self.recording:
            return

        self.audio_chunks = []
        self.last_text = ""
        self.stop_event.clear()
        self.recording = True

        self.stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            blocksize=BLOCK_SIZE,
            dtype="float32",
            callback=self.audio_callback,
        )
        self.stream.start()

        self.worker = threading.Thread(target=self.infer_loop, daemon=True)
        self.worker.start()

        emit({"status": "recording"})

    def stop(self):
        if not self.recording:
            emit({"status": "stopped"})
            return

        self.recording = False
        self.stop_event.set()

        if self.stream:
            self.stream.stop()
            self.stream.close()
            self.stream = None

        if self.worker:
            self.worker.join(timeout=10)
            self.worker = None

        final_text = self.run_inference(force=True)
        if final_text and final_text != self.last_text:
            self.last_text = final_text
            emit({"type": "final", "text": final_text, "time": time.time()})

        emit({"status": "stopped"})

    def collect_audio(self):
        while True:
            try:
                self.audio_chunks.append(self.audio_queue.get_nowait())
            except queue.Empty:
                break

        if not self.audio_chunks:
            return np.zeros((0,), dtype=np.float32)

        audio = np.concatenate(self.audio_chunks, axis=0).reshape(-1)
        max_samples = int(MAX_AUDIO_SECONDS * SAMPLE_RATE)
        if audio.shape[0] > max_samples:
            audio = audio[-max_samples:]
            self.audio_chunks = [audio.reshape(-1, 1)]

        return audio

    def infer_loop(self):
        emit({"type": "started", "text": "", "time": time.time()})

        while not self.stop_event.wait(INFER_INTERVAL_SECONDS):
            text = self.run_inference(force=False)
            if text and text != self.last_text:
                self.last_text = text
                emit({"type": "partial", "text": text, "time": time.time()})

    def run_inference(self, force=False):
        audio = self.collect_audio()
        if audio.shape[0] < int(MIN_AUDIO_SECONDS * SAMPLE_RATE) and not force:
            return self.last_text

        if audio.shape[0] == 0:
            return self.last_text

        wav_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                wav_path = tmp.name

            sf.write(wav_path, audio, SAMPLE_RATE)

            with torch.no_grad(), torch.inference_mode():
                if self.supports_cache_aware and hasattr(
                    self.model, "transcribe_simulate_cache_aware_streaming"
                ):
                    try:
                        result = self.model.transcribe_simulate_cache_aware_streaming(
                            [wav_path],
                            batch_size=1,
                            online_normalization=True,
                        )
                    except Exception as cache_err:
                        if "does not support" in str(cache_err):
                            self.supports_cache_aware = False
                            sys.stderr.write(
                                "[PARAKEET] Cache-aware streaming unsupported for this model; "
                                "falling back to .transcribe()\n"
                            )
                            sys.stderr.flush()
                            result = self.model.transcribe([wav_path])
                        else:
                            raise
                else:
                    result = self.model.transcribe([wav_path])

            return normalize_result(result)
        except Exception as error:
            emit({"error": str(error)})
            return self.last_text
        finally:
            if wav_path and os.path.exists(wav_path):
                try:
                    os.unlink(wav_path)
                except OSError:
                    pass

    def run(self):
        self.load_model()

        while True:
            line = sys.stdin.readline()
            if not line:
                break

            try:
                command = json.loads(line.strip()).get("command")
                if command == "start":
                    self.start()
                elif command == "stop":
                    self.stop()
                elif command == "quit":
                    self.stop()
                    break
            except Exception as error:
                emit({"error": str(error)})

        emit({"status": "shutdown"})


if __name__ == "__main__":
    try:
        ParakeetStreamingServer().run()
    except KeyboardInterrupt:
        emit({"status": "shutdown"})
    except Exception as error:
        emit({"error": str(error)})
        sys.exit(1)
