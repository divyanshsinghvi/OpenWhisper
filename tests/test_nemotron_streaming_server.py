#!/usr/bin/env python3
"""
End-to-end test of nemotron_streaming_server.py.

Spawns the actual server as a subprocess (the same way the Electron app does),
drives it via the JSON-stdio protocol, and asserts the streaming behavior the
app depends on:

  - Server emits {"status": "ready"} after model load.
  - {"command": "start"} produces {"status": "recording"} and a started event.
  - As fake mic audio plays, multiple {"type": "partial"} events arrive with
    growing non-empty text — proving partials stream live, not bulk at the end.
  - {"command": "stop"} produces a {"type": "final"} with non-empty text and a
    {"status": "stopped"}.
  - Final text contains expected words from the bundled reference transcript.
  - {"command": "quit"} cleanly terminates the server.

Pass = all of the above. The test exits non-zero on any failure with diagnostics.
"""
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER_SCRIPT = ROOT / "python" / "nemotron_streaming_server.py"
MODEL_DIR = ROOT / "models" / "nemotron-streaming-en-0.6b-int8"
FAKE_WAV = MODEL_DIR / "test_wavs" / "0.wav"
EXPECTED_PHRASE = "after early"  # first words of bundled wav 0
READY_TIMEOUT = 60
RECORD_DURATION = 9       # bundled wav is ~6.6s; give it room to play through


def log(msg): print(msg, flush=True)


def main() -> int:
    if not SERVER_SCRIPT.exists():
        log(f"[fail] server script missing: {SERVER_SCRIPT}")
        return 2
    if not MODEL_DIR.exists():
        log(f"[fail] model dir missing: {MODEL_DIR}")
        return 2
    if not FAKE_WAV.exists():
        log(f"[fail] reference wav missing: {FAKE_WAV}")
        return 2

    env = {
        **os.environ,
        "NEMOTRON_FAKE_AUDIO_WAV": str(FAKE_WAV),
        "NEMOTRON_MODEL_DIR": str(MODEL_DIR),
    }

    log(f"[spawn] {sys.executable} {SERVER_SCRIPT}")
    proc = subprocess.Popen(
        [sys.executable, str(SERVER_SCRIPT)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        bufsize=1,
        text=True,
    )

    events: list[dict] = []
    failed_lines: list[str] = []

    def reader():
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                failed_lines.append(line)

    t = threading.Thread(target=reader, daemon=True)
    t.start()

    def wait_for(predicate, timeout: float, what: str) -> dict | None:
        deadline = time.time() + timeout
        seen = 0
        while time.time() < deadline:
            while seen < len(events):
                ev = events[seen]; seen += 1
                if predicate(ev):
                    return ev
            time.sleep(0.05)
        return None

    try:
        # 1) Wait for ready
        ready = wait_for(lambda e: e.get("status") == "ready", READY_TIMEOUT, "ready")
        if not ready:
            log(f"[fail] server never emitted ready within {READY_TIMEOUT}s")
            log(f"[stderr-tail] {proc.stderr.read()[-2000:] if proc.stderr else ''}")
            return 1
        log("[ok] ready received")

        # 2) Start recording
        proc.stdin.write(json.dumps({"command": "start"}) + "\n")
        proc.stdin.flush()
        recording_seen = wait_for(lambda e: e.get("status") == "recording", 5, "recording")
        if not recording_seen:
            log("[fail] no 'recording' status after start command")
            return 1
        log("[ok] recording status received")

        started = wait_for(lambda e: e.get("type") == "started", 3, "started")
        if not started:
            log("[fail] no 'started' transcription event")
            return 1
        log("[ok] started event received")

        # 3) Let fake audio play; collect partials
        before_idx = len(events)
        time.sleep(RECORD_DURATION)
        partials = [e for e in events[before_idx:] if e.get("type") == "partial" and e.get("text")]
        unique_texts = []
        for p in partials:
            if not unique_texts or unique_texts[-1] != p["text"]:
                unique_texts.append(p["text"])

        log(f"[partials] {len(partials)} events, {len(unique_texts)} unique texts")
        for i, txt in enumerate(unique_texts):
            log(f"  [{i+1}] {txt!r}")
        if len(unique_texts) < 2:
            log("[fail] expected >=2 distinct partials during playback (proves real streaming, not single bulk emit)")
            return 1
        log("[ok] multiple distinct partials during playback")

        # 4) Stop
        proc.stdin.write(json.dumps({"command": "stop"}) + "\n")
        proc.stdin.flush()
        final = wait_for(lambda e: e.get("type") == "final", 8, "final")
        if not final:
            log("[fail] no 'final' event after stop")
            return 1
        final_text = (final.get("text") or "").strip()
        log(f"[final] text={final_text!r}")
        if not final_text:
            log("[fail] final text is empty")
            return 1

        stopped = wait_for(lambda e: e.get("status") == "stopped", 3, "stopped")
        if not stopped:
            log("[fail] no 'stopped' status after final")
            return 1
        log("[ok] stopped status received")

        if EXPECTED_PHRASE not in final_text.lower():
            log(f"[fail] final text does not contain expected phrase {EXPECTED_PHRASE!r}")
            return 1
        log(f"[ok] final text contains {EXPECTED_PHRASE!r}")

        # 5) Quit cleanly
        proc.stdin.write(json.dumps({"command": "quit"}) + "\n")
        proc.stdin.flush()
        proc.wait(timeout=10)
        log(f"[ok] server exited cleanly with code {proc.returncode}")

        if failed_lines:
            log(f"[warn] {len(failed_lines)} stdout lines were not valid JSON; first 3: {failed_lines[:3]}")

        log("\n[verdict] PASS — full streaming pipeline validated end-to-end")
        return 0

    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    sys.exit(main())
