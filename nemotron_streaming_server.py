#!/usr/bin/env python3
"""
NVIDIA Nemotron Speech Streaming server.

Wraps sherpa-onnx OnlineRecognizer for true cache-aware streaming. Captures
microphone audio in 100ms blocks, feeds them into the recognizer, and emits
JSON events compatible with the existing Parakeet/Moonshine streaming clients.

Stdout protocol (one JSON object per line):
  {"status": "loading"}
  {"status": "ready"}
  {"status": "recording"}
  {"status": "stopped"}
  {"type": "started", "text": "", "time": ...}
  {"type": "partial", "text": "...", "time": ...}
  {"type": "final",   "text": "...", "time": ...}
  {"error": "..."}

Stdin protocol (one JSON command per line):
  {"command": "start"}
  {"command": "stop"}
  {"command": "quit"}
"""
import json
import os
import queue
import sys
import threading
import time
from pathlib import Path

import numpy as np
import sherpa_onnx

# Fake-mic mode for integration testing: when NEMOTRON_FAKE_AUDIO_WAV is set,
# we replay that wav into the recognizer at real-time pace instead of opening
# a real microphone. Used by test_nemotron_streaming_server.py.
FAKE_AUDIO_WAV = os.environ.get("NEMOTRON_FAKE_AUDIO_WAV", "")
if not FAKE_AUDIO_WAV:
    import sounddevice as sd  # type: ignore
else:
    import soundfile as sf  # type: ignore
    sd = None  # type: ignore

SAMPLE_RATE = 16000
CHANNELS = 1
BLOCK_SIZE = 1600  # 100ms

DEFAULT_MODEL_DIR = Path(__file__).resolve().parent / "models" / "nemotron-streaming-en-0.6b-int8"
MODEL_DIR = Path(os.environ.get("NEMOTRON_MODEL_DIR", str(DEFAULT_MODEL_DIR)))

sys.stdout = open(sys.stdout.fileno(), mode="w", buffering=1, encoding="utf8")


def emit(message: dict) -> None:
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def find_one(stems: list[str]) -> str:
    for stem in stems:
        path = MODEL_DIR / stem
        if path.exists():
            return str(path)
    raise FileNotFoundError(f"None of {stems} found in {MODEL_DIR}")


class NemotronStreamingServer:
    def __init__(self) -> None:
        self.recognizer: sherpa_onnx.OnlineRecognizer | None = None
        self.stream: sherpa_onnx.OnlineStream | None = None
        self.audio_queue: queue.Queue = queue.Queue()
        self.input_stream: sd.InputStream | None = None
        self.recording = False
        self.stop_event = threading.Event()
        self.worker: threading.Thread | None = None
        self.last_partial = ""
        self.committed_finals: list[str] = []

    def load_recognizer(self) -> None:
        if not MODEL_DIR.exists():
            emit({"error": f"model dir not found: {MODEL_DIR}"})
            raise FileNotFoundError(MODEL_DIR)

        emit({"status": "loading"})

        encoder = find_one(["encoder.int8.onnx", "encoder.onnx"])
        decoder = find_one(["decoder.int8.onnx", "decoder.onnx"])
        joiner = find_one(["joiner.int8.onnx", "joiner.onnx"])
        tokens = find_one(["tokens.txt"])

        sys.stderr.write(f"[NEMOTRON] Loading recognizer from {MODEL_DIR}\n")
        sys.stderr.flush()

        self.recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
            encoder=encoder,
            decoder=decoder,
            joiner=joiner,
            tokens=tokens,
            num_threads=int(os.environ.get("NEMOTRON_NUM_THREADS", "2")),
            sample_rate=SAMPLE_RATE,
            feature_dim=80,
            decoding_method="greedy_search",
            provider="cpu",
            enable_endpoint_detection=True,
            rule1_min_trailing_silence=2.4,
            rule2_min_trailing_silence=1.2,
            rule3_min_utterance_length=20.0,
        )

        sys.stderr.write("[NEMOTRON] Recognizer ready.\n")
        sys.stderr.flush()
        emit({"status": "ready"})

    def audio_callback(self, indata, frames, time_info, status) -> None:
        if status:
            sys.stderr.write(f"[NEMOTRON] Audio status: {status}\n")
            sys.stderr.flush()
        if self.recording:
            # indata is shape (frames, channels) float32
            self.audio_queue.put(indata[:, 0].copy())

    def get_full_text(self) -> str:
        parts = list(self.committed_finals)
        if self.last_partial:
            parts.append(self.last_partial)
        return " ".join(p.strip() for p in parts if p.strip()).strip()

    def start(self) -> None:
        if self.recording:
            return
        if not self.recognizer:
            emit({"error": "recognizer not loaded"})
            return

        self.last_partial = ""
        self.committed_finals = []
        self.stream = self.recognizer.create_stream()
        # Drain any stale frames captured between sessions
        while True:
            try:
                self.audio_queue.get_nowait()
            except queue.Empty:
                break
        self.stop_event.clear()
        self.recording = True

        if FAKE_AUDIO_WAV:
            self._fake_audio_thread = threading.Thread(
                target=self._replay_wav, args=(FAKE_AUDIO_WAV,), daemon=True
            )
            self._fake_audio_thread.start()
        else:
            self.input_stream = sd.InputStream(
                samplerate=SAMPLE_RATE,
                channels=CHANNELS,
                blocksize=BLOCK_SIZE,
                dtype="float32",
                callback=self.audio_callback,
            )
            self.input_stream.start()

        self.worker = threading.Thread(target=self.decode_loop, daemon=True)
        self.worker.start()

        emit({"status": "recording"})
        emit({"type": "started", "text": "", "time": time.time()})

    def _replay_wav(self, wav_path: str) -> None:
        """Push wav samples into the audio queue at real-time pace."""
        try:
            audio, sr = sf.read(wav_path, dtype="float32")
            if audio.ndim > 1:
                audio = audio.mean(axis=1)
            if sr != SAMPLE_RATE:
                emit({"error": f"fake wav must be {SAMPLE_RATE}Hz, got {sr}"})
                return
            block_dur = BLOCK_SIZE / SAMPLE_RATE
            for i in range(0, len(audio), BLOCK_SIZE):
                if self.stop_event.is_set():
                    break
                if not self.recording:
                    break
                self.audio_queue.put(audio[i:i + BLOCK_SIZE].copy())
                time.sleep(block_dur)
        except Exception as e:
            emit({"error": f"fake-audio thread crashed: {e}"})

    def decode_loop(self) -> None:
        assert self.recognizer is not None
        assert self.stream is not None
        recognizer = self.recognizer
        stream = self.stream

        while not self.stop_event.is_set():
            try:
                samples = self.audio_queue.get(timeout=0.1)
            except queue.Empty:
                continue

            stream.accept_waveform(SAMPLE_RATE, samples)
            while recognizer.is_ready(stream):
                recognizer.decode_stream(stream)

            partial = (recognizer.get_result(stream) or "").strip()
            endpoint = recognizer.is_endpoint(stream)

            if partial and partial != self.last_partial:
                self.last_partial = partial
                emit({"type": "partial", "text": self.get_full_text(), "time": time.time()})

            if endpoint:
                if partial:
                    self.committed_finals.append(partial)
                self.last_partial = ""
                recognizer.reset(stream)
                emit({"type": "partial", "text": self.get_full_text(), "time": time.time()})

    def stop(self) -> None:
        if not self.recording:
            emit({"status": "stopped"})
            return

        self.recording = False
        self.stop_event.set()

        if self.input_stream is not None:
            try:
                self.input_stream.stop()
                self.input_stream.close()
            finally:
                self.input_stream = None

        if self.worker is not None:
            self.worker.join(timeout=3)
            self.worker = None

        # Flush remaining audio + tail decoding.
        if self.recognizer and self.stream:
            recognizer = self.recognizer
            stream = self.stream
            while True:
                try:
                    samples = self.audio_queue.get_nowait()
                except queue.Empty:
                    break
                stream.accept_waveform(SAMPLE_RATE, samples)

            try:
                stream.input_finished()
            except Exception:
                pass
            while recognizer.is_ready(stream):
                recognizer.decode_stream(stream)
            tail = (recognizer.get_result(stream) or "").strip()
            if tail and (not self.committed_finals or self.committed_finals[-1] != tail):
                self.committed_finals.append(tail)
            self.last_partial = ""

        full = self.get_full_text()
        emit({"type": "final", "text": full, "time": time.time()})
        emit({"status": "stopped"})

        # Reset stream reference; a fresh one is created on next start.
        self.stream = None

    def run(self) -> None:
        self.load_recognizer()

        while True:
            line = sys.stdin.readline()
            if not line:
                break
            try:
                command = json.loads(line.strip()).get("command")
            except Exception as error:
                emit({"error": str(error)})
                continue

            if command == "start":
                self.start()
            elif command == "stop":
                self.stop()
            elif command == "quit":
                self.stop()
                break

        emit({"status": "shutdown"})


if __name__ == "__main__":
    try:
        NemotronStreamingServer().run()
    except KeyboardInterrupt:
        emit({"status": "shutdown"})
    except Exception as error:
        emit({"error": str(error)})
        sys.exit(1)
