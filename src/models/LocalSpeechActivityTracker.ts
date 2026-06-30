const SAMPLE_RATE = 16000;
const WEBRTC_FRAME_MS = 30;
const WEBRTC_FRAME_BYTES = (SAMPLE_RATE * WEBRTC_FRAME_MS / 1000) * 2;
const DEFAULT_AUTO_STOP_SILENCE_MS = 3000;
const DEFAULT_VAD_RMS_THRESHOLD = 500;
const DEFAULT_WEBRTC_AGGRESSIVENESS = 2;

type VadMode = 'webrtc' | 'rms';

function autoStopSilenceMs(): number {
  return Number(process.env.OPENWHISPER_AUTO_STOP_SILENCE_MS || DEFAULT_AUTO_STOP_SILENCE_MS);
}

function vadRmsThreshold(): number {
  return Number(process.env.OPENWHISPER_VAD_RMS_THRESHOLD || DEFAULT_VAD_RMS_THRESHOLD);
}

function vadMode(): VadMode {
  return process.env.OPENWHISPER_VAD_MODE === 'rms' ? 'rms' : 'webrtc';
}

function webrtcAggressiveness(): number {
  const configured = Number(process.env.OPENWHISPER_WEBRTC_VAD_AGGRESSIVENESS || DEFAULT_WEBRTC_AGGRESSIVENESS);
  return Math.max(0, Math.min(3, configured));
}

function pcm16Rms(chunk: Buffer): number {
  const samples = Math.floor(chunk.length / 2);
  if (samples === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < samples; i += 1) {
    const sample = chunk.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / samples);
}

function createWebRtcVad(): any | null {
  if (vadMode() !== 'webrtc') return null;

  try {
    // Native module. Keep optional at runtime so packaged Electron builds can
    // fall back to RMS if the addon was not rebuilt for Electron's ABI.
    const VAD = require('webrtcvad').default || require('webrtcvad');
    return new VAD(SAMPLE_RATE, webrtcAggressiveness());
  } catch (error) {
    console.log(`[WARN] WebRTC VAD unavailable; falling back to RMS VAD: ${error}`);
    return null;
  }
}

export class LocalSpeechActivityTracker {
  private readonly vad = createWebRtcVad();
  private readonly silenceMs = autoStopSilenceMs();
  private lastSpeechAt = Date.now();
  private autoStopEmitted = false;
  private frameBuffer = Buffer.alloc(0);

  reset(): void {
    this.lastSpeechAt = Date.now();
    this.autoStopEmitted = false;
    this.frameBuffer = Buffer.alloc(0);
  }

  track(chunk: Buffer): { shouldAutoStop: boolean; silenceMs: number } {
    if (this.silenceMs <= 0 || this.autoStopEmitted) {
      return { shouldAutoStop: false, silenceMs: this.silenceMs };
    }

    if (this.containsSpeech(chunk)) {
      this.lastSpeechAt = Date.now();
      return { shouldAutoStop: false, silenceMs: this.silenceMs };
    }

    if (Date.now() - this.lastSpeechAt >= this.silenceMs) {
      this.autoStopEmitted = true;
      return { shouldAutoStop: true, silenceMs: this.silenceMs };
    }

    return { shouldAutoStop: false, silenceMs: this.silenceMs };
  }

  private containsSpeech(chunk: Buffer): boolean {
    if (!this.vad) {
      return pcm16Rms(chunk) >= vadRmsThreshold();
    }

    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);
    let speech = false;

    while (this.frameBuffer.length >= WEBRTC_FRAME_BYTES) {
      const frame = this.frameBuffer.subarray(0, WEBRTC_FRAME_BYTES);
      this.frameBuffer = this.frameBuffer.subarray(WEBRTC_FRAME_BYTES);
      speech = this.vad.process(frame) || speech;
    }

    return speech;
  }
}
