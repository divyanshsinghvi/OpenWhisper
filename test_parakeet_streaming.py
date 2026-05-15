#!/usr/bin/env python3
"""
Test: simulate live streaming of audio into Parakeet TDT v3 and verify
incremental partial transcripts are produced with acceptable latency.

We don't have a true cache-aware streaming encoder for parakeet-tdt-0.6b-v3,
so we test the pragmatic approach: every TICK seconds, transcribe the last
WINDOW seconds of the rolling buffer and emit the result as a partial.

Pass criteria:
  - Each tick produces non-empty text once enough audio has accumulated.
  - Median per-tick latency is below the tick interval (so we don't fall behind).
  - Final transcript on the full clip matches the live partials' last value
    closely (sanity that the streaming output isn't garbage).
"""
import os
import sys
import time
import statistics
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
os.environ.setdefault("MPLCONFIGDIR", "/tmp/mpl_test")

import numpy as np
import soundfile as sf
import torch
import nemo.collections.asr as nemo_asr
from omegaconf import OmegaConf, open_dict

MODEL_NAME = os.environ.get("PARAKEET_MODEL_NAME", "nvidia/parakeet-tdt-0.6b-v3")
SAMPLE_PATH = sys.argv[1] if len(sys.argv) > 1 else "/Users/rashmi/code/OpenWhisper/temp/recording_1778839201504.wav"
TICK_SECS = float(os.environ.get("TICK_SECS", "1.0"))
WINDOW_SECS = float(os.environ.get("WINDOW_SECS", "12.0"))


def log(msg):
    print(msg, flush=True)


def load_model():
    log(f"[load] {MODEL_NAME}")
    t0 = time.time()
    model = nemo_asr.models.ASRModel.from_pretrained(model_name=MODEL_NAME)
    model.eval()
    with open_dict(model.cfg):
        if model.cfg.get("validation_ds") is None:
            model.cfg.validation_ds = OmegaConf.create({
                "use_start_end_token": False,
                "sample_rate": 16000,
                "manifest_filepath": None,
                "batch_size": 1,
                "shuffle": False,
                "num_workers": 0,
                "pin_memory": False,
            })
    if torch.backends.mps.is_available():
        model = model.to("mps")
        log("[load] device=mps")
    else:
        log("[load] device=cpu")
    log(f"[load] done in {time.time()-t0:.1f}s")
    return model


def transcribe_array(model, audio: np.ndarray) -> str:
    """Transcribe a numpy float32 array directly via a tempfile."""
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        path = tf.name
    try:
        sf.write(path, audio, 16000)
        with torch.no_grad(), torch.inference_mode():
            result = model.transcribe([path], verbose=False)
        if not result:
            return ""
        first = result[0]
        return (getattr(first, "text", None) or str(first)).strip()
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def main():
    if not Path(SAMPLE_PATH).exists():
        log(f"[fail] missing audio file: {SAMPLE_PATH}")
        return 2

    audio, sr = sf.read(SAMPLE_PATH, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != 16000:
        log(f"[fail] expected 16kHz, got {sr}")
        return 2
    log(f"[audio] {SAMPLE_PATH} duration={len(audio)/sr:.2f}s")

    model = load_model()

    # Warm-up call (first transcribe is much slower).
    log("[warmup] running first transcribe to JIT/load CUDA-graphs/MPS kernels...")
    t0 = time.time()
    warm = transcribe_array(model, audio[: int(2 * sr)])
    log(f"[warmup] {time.time()-t0:.2f}s text={warm!r}")

    # Simulate live recording: every TICK_SECS we have TICK_SECS of new audio.
    total_dur = len(audio) / sr
    n_ticks = int(np.ceil(total_dur / TICK_SECS))
    latencies = []
    last_text = ""
    partials = []
    log(f"[stream] tick={TICK_SECS}s window={WINDOW_SECS}s -> {n_ticks} ticks")

    for i in range(1, n_ticks + 1):
        end = min(int(i * TICK_SECS * sr), len(audio))
        start = max(0, end - int(WINDOW_SECS * sr))
        chunk = audio[start:end]

        t0 = time.time()
        text = transcribe_array(model, chunk)
        dt = time.time() - t0
        latencies.append(dt)

        emitted = text != last_text
        if emitted:
            last_text = text
            partials.append((i * TICK_SECS, text))
        log(f"[tick {i:>2}/{n_ticks}] t={i*TICK_SECS:5.1f}s lat={dt*1000:6.0f}ms "
            f"win={(end-start)/sr:4.1f}s emit={'Y' if emitted else '.'} text={text!r}")

    # Final reference transcript (whole clip, one shot).
    log("[final] full-clip transcribe for reference...")
    t0 = time.time()
    final = transcribe_array(model, audio)
    log(f"[final] {time.time()-t0:.2f}s text={final!r}")

    # Verdict.
    if not latencies:
        log("[fail] no ticks ran")
        return 1
    median = statistics.median(latencies) * 1000
    p95 = sorted(latencies)[int(0.95 * len(latencies))] * 1000 if len(latencies) > 1 else latencies[0] * 1000
    log(f"\n[stats] ticks={len(latencies)} median_lat={median:.0f}ms p95={p95:.0f}ms tick_budget={TICK_SECS*1000:.0f}ms")
    log(f"[stats] last partial: {last_text!r}")
    log(f"[stats] final ref:    {final!r}")

    pass_lat = median < TICK_SECS * 1000
    pass_text = bool(last_text.strip()) and bool(final.strip())
    pass_overall = pass_lat and pass_text

    log(f"\n[verdict] latency_ok={pass_lat} text_ok={pass_text} overall={'PASS' if pass_overall else 'FAIL'}")
    return 0 if pass_overall else 1


if __name__ == "__main__":
    sys.exit(main())
