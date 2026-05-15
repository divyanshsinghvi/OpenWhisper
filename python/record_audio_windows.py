#!/usr/bin/env python3
"""
Fast Windows Audio Recording using PyAudioWPatch
Uses native WASAPI for direct hardware access
Writes proper WAV format with correct headers
"""
import pyaudiowpatch as pyaudio
import wave
import sys
import signal
import threading

is_recording = True
audio_stream = None
wf = None

def signal_handler(sig, frame):
    global is_recording
    is_recording = False
    print("Stopping recording...", flush=True)

def record_audio(output_path):
    """Record audio from microphone using PyAudioWPatch"""
    global is_recording, audio_stream, wf

    sample_rate = 16000
    channels = 1
    chunk_size = 4096
    sample_width = 2  # 16-bit

    print(f"Recording to {output_path}...", flush=True)

    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    try:
        # Initialize PyAudio (WASAPI on Windows)
        p = pyaudio.PyAudio()

        # Open audio stream
        audio_stream = p.open(
            format=pyaudio.paInt16,
            channels=channels,
            rate=sample_rate,
            input=True,
            frames_per_buffer=chunk_size,
            input_device_index=None  # Auto-detect default microphone
        )

        # Open WAV file for writing
        wf = wave.open(output_path, 'wb')
        wf.setnchannels(channels)
        wf.setsampwidth(sample_width)
        wf.setframerate(sample_rate)

        print("Microphone active. Press Ctrl+C to stop.", flush=True)

        # Record until stopped
        while is_recording:
            try:
                data = audio_stream.read(chunk_size, exception_on_overflow=False)
                wf.writeframes(data)
            except Exception as e:
                print(f"Error reading audio: {e}", flush=True)
                break

    except Exception as e:
        print(f"Error: {e}", flush=True)
        sys.exit(1)
    finally:
        # Cleanup
        if audio_stream:
            audio_stream.stop_stream()
            audio_stream.close()
        if wf:
            wf.close()
        if 'p' in locals():
            p.terminate()
        print(f"Recording saved to {output_path}", flush=True)

if __name__ == '__main__':
    if len(sys.argv) > 1:
        output_path = sys.argv[1]
        record_audio(output_path)
    else:
        print("Usage: python record_audio_windows.py <output_path>")
