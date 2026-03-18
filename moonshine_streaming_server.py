#!/usr/bin/env python3
"""
Moonshine v2 Streaming Server
Uses moonshine-voice SDK for real-time streaming transcription.
Communicates via stdin/stdout using JSON messages.
"""
import sys
import json
import threading

# Ensure stdout is line-buffered for real-time JSON communication
sys.stdout = open(sys.stdout.fileno(), mode='w', buffering=1, encoding='utf8')

from moonshine_voice import (
    MicTranscriber,
    TranscriptEventListener,
    get_model_for_language,
)


class StreamingListener(TranscriptEventListener):
    """Sends transcription events as JSON to stdout."""

    def on_line_started(self, event):
        msg = {"type": "started", "text": event.line.text, "time": event.line.start_time}
        sys.stdout.write(json.dumps(msg) + '\n')
        sys.stdout.flush()

    def on_line_text_changed(self, event):
        msg = {"type": "partial", "text": event.line.text, "time": event.line.start_time}
        sys.stdout.write(json.dumps(msg) + '\n')
        sys.stdout.flush()

    def on_line_completed(self, event):
        msg = {"type": "final", "text": event.line.text, "time": event.line.start_time}
        sys.stdout.write(json.dumps(msg) + '\n')
        sys.stdout.flush()


def main():
    sys.stderr.write('[MOONSHINE] Loading model...\n')
    sys.stderr.flush()

    sys.stdout.write(json.dumps({"status": "loading"}) + '\n')
    sys.stdout.flush()

    model_path, model_arch = get_model_for_language("en")

    transcriber = MicTranscriber(
        model_path=model_path,
        model_arch=model_arch,
    )
    transcriber.add_listener(StreamingListener())

    sys.stderr.write('[MOONSHINE] Model loaded, ready.\n')
    sys.stderr.flush()

    sys.stdout.write(json.dumps({"status": "ready"}) + '\n')
    sys.stdout.flush()

    running = False

    # Read commands from stdin
    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break

            cmd = json.loads(line.strip())
            command = cmd.get("command")

            if command == "start" and not running:
                transcriber.start()
                running = True
                sys.stdout.write(json.dumps({"status": "recording"}) + '\n')
                sys.stdout.flush()

            elif command == "stop" and running:
                transcriber.stop()
                running = False
                sys.stdout.write(json.dumps({"status": "stopped"}) + '\n')
                sys.stdout.flush()

            elif command == "quit":
                if running:
                    transcriber.stop()
                break

        except json.JSONDecodeError as e:
            sys.stdout.write(json.dumps({"error": f"Invalid JSON: {str(e)}"}) + '\n')
            sys.stdout.flush()
        except Exception as e:
            sys.stdout.write(json.dumps({"error": str(e)}) + '\n')
            sys.stdout.flush()

    sys.stdout.write(json.dumps({"status": "shutdown"}) + '\n')
    sys.stdout.flush()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print(json.dumps({"status": "shutdown"}), flush=True)
    except Exception as e:
        print(json.dumps({"error": str(e)}), flush=True)
        sys.exit(1)
