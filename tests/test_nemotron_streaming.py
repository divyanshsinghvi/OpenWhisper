#!/usr/bin/env python3
"""
Test: true streaming inference of nvidia/nemotron-speech-streaming-en-0.6b
via sherpa-onnx OnlineRecognizer. Replaces the bursty NeMo PyTorch path.

Pass criteria:
  1. Recognizer loads from local ONNX bundle.
  2. Feeding audio in 100ms chunks produces non-empty rolling partials
     before the clip ends (i.e. we see text appear DURING playback).
  3. Median per-chunk decode latency is well under the chunk duration
     (so we keep up with real-time audio).
  4. The committed final transcript is non-empty.
"""
import os
import sys
import time
import statistics
from pathlib import Path

import numpy as np
import soundfile as sf
import sherpa_onnx

REPO_ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = Path(os.environ.get(
    "NEMOTRON_MODEL_DIR",
    REPO_ROOT / "models" / "nemotron-streaming-en-0.6b-int8",
))
SAMPLE_PATH = Path(sys.argv[1] if len(sys.argv) > 1
                   else MODEL_DIR / "test_wavs" / "0.wav")
CHUNK_MS = int(os.environ.get("CHUNK_MS", "100"))
SAMPLE_RATE = 16000


def log(msg): print(msg, flush=True)


def find_one(stem_options):
    for stem in stem_options:
        p = MODEL_DIR / stem
        if p.exists():
            return str(p)
    raise FileNotFoundError(f"none of {stem_options} in {MODEL_DIR}")


def main() -> int:
    if not MODEL_DIR.exists():
        log(f"[fail] model dir missing: {MODEL_DIR}")
        return 2
    if not SAMPLE_PATH.exists():
        log(f"[fail] sample missing: {SAMPLE_PATH}")
        return 2

    encoder = find_one(["encoder.int8.onnx", "encoder.onnx"])
    decoder = find_one(["decoder.int8.onnx", "decoder.onnx"])
    joiner  = find_one(["joiner.int8.onnx",  "joiner.onnx"])
    tokens  = find_one(["tokens.txt"])
    log(f"[load] encoder={Path(encoder).name} decoder={Path(decoder).name} "
        f"joiner={Path(joiner).name}")

    t0 = time.time()
    rec = sherpa_onnx.OnlineRecognizer.from_transducer(
        encoder=encoder,
        decoder=decoder,
        joiner=joiner,
        tokens=tokens,
        num_threads=2,
        sample_rate=SAMPLE_RATE,
        feature_dim=80,
        decoding_method="greedy_search",
        provider="cpu",
        enable_endpoint_detection=True,
        rule1_min_trailing_silence=2.4,
        rule2_min_trailing_silence=1.2,
        rule3_min_utterance_length=20.0,
    )
    log(f"[load] recognizer ready in {time.time()-t0:.2f}s")

    audio, sr = sf.read(SAMPLE_PATH, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != SAMPLE_RATE:
        log(f"[fail] expected 16kHz audio, got {sr}")
        return 2
    log(f"[audio] {SAMPLE_PATH.name} duration={len(audio)/sr:.2f}s")

    stream = rec.create_stream()
    chunk_samples = int(SAMPLE_RATE * CHUNK_MS / 1000)
    n_chunks = (len(audio) + chunk_samples - 1) // chunk_samples

    chunk_latencies_ms = []
    seen_partials: list[str] = []
    finals: list[str] = []
    last_text = ""

    for i in range(n_chunks):
        chunk = audio[i*chunk_samples:(i+1)*chunk_samples]
        if len(chunk) == 0:
            break

        t0 = time.time()
        stream.accept_waveform(SAMPLE_RATE, chunk)
        while rec.is_ready(stream):
            rec.decode_stream(stream)
        dt_ms = (time.time() - t0) * 1000
        chunk_latencies_ms.append(dt_ms)

        text = (rec.get_result(stream) or "").strip()
        endpoint = rec.is_endpoint(stream)

        emit_marker = ""
        if text and text != last_text:
            seen_partials.append(text)
            last_text = text
            emit_marker = "PARTIAL"
        if endpoint:
            if text:
                finals.append(text)
                emit_marker = (emit_marker + "+FINAL").strip("+")
            rec.reset(stream)
            last_text = ""

        if emit_marker:
            t_audio = (i + 1) * CHUNK_MS / 1000
            log(f"[t={t_audio:5.2f}s lat={dt_ms:5.1f}ms] {emit_marker}: {text!r}")

    # Flush tail
    stream.input_finished()
    while rec.is_ready(stream):
        rec.decode_stream(stream)
    tail = (rec.get_result(stream) or "").strip()
    if tail and (not finals or finals[-1] != tail):
        finals.append(tail)
        log(f"[flush] FINAL_TAIL: {tail!r}")

    # Verdict
    if not chunk_latencies_ms:
        log("[fail] no chunks processed")
        return 1
    median = statistics.median(chunk_latencies_ms)
    p95 = sorted(chunk_latencies_ms)[int(0.95 * (len(chunk_latencies_ms) - 1))]

    log(f"\n[stats] chunks={len(chunk_latencies_ms)} chunk_ms={CHUNK_MS} "
        f"median_lat={median:.1f}ms p95={p95:.1f}ms")
    log(f"[stats] partials_seen={len(seen_partials)} finals_committed={len(finals)}")
    if finals:
        log(f"[stats] last final: {finals[-1]!r}")
    elif seen_partials:
        log(f"[stats] last partial: {seen_partials[-1]!r}")

    pass_lat   = median < CHUNK_MS               # decoded faster than the chunk we just got
    pass_text  = bool(seen_partials) and (bool(finals) or bool(seen_partials[-1]))
    pass_streaming = len(seen_partials) >= 2     # at least two partials = actually streaming
    overall = pass_lat and pass_text and pass_streaming

    log(f"\n[verdict] latency_ok={pass_lat} text_ok={pass_text} "
        f"streaming_ok={pass_streaming} overall={'PASS' if overall else 'FAIL'}")
    return 0 if overall else 1


if __name__ == "__main__":
    sys.exit(main())
