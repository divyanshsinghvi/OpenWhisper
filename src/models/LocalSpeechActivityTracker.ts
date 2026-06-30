const SAMPLE_RATE = 16000;
const WEBRTC_FRAME_MS = 30;
const WEBRTC_FRAME_BYTES = (SAMPLE_RATE * WEBRTC_FRAME_MS / 1000) * 2;
const DEFAULT_AUTO_STOP_SILENCE_MS = 3000;
const DEFAULT_VAD_RMS_THRESHOLD = 500;
const DEFAULT_WEBRTC_AGGRESSIVENESS = 2;
const DEFAULT_WEBRTC_MIN_SPEECH_RATIO = 0.5;

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

function vadDebugEnabled(): boolean {
  return process.env.OPENWHISPER_VAD_DEBUG === '1';
}

function webrtcAggressiveness(): number {
  const configured = Number(process.env.OPENWHISPER_WEBRTC_VAD_AGGRESSIVENESS || DEFAULT_WEBRTC_AGGRESSIVENESS);
  return Math.max(0, Math.min(3, configured));
}

function webrtcMinSpeechRatio(): number {
  const configured = Number(process.env.OPENWHISPER_WEBRTC_VAD_MIN_SPEECH_RATIO || DEFAULT_WEBRTC_MIN_SPEECH_RATIO);
  return Math.max(0, Math.min(1, configured));
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
  private lastDebugAt = 0;
  private autoStopEmitted = false;
  private frameBuffer = Buffer.alloc(0);
  private lastVoicedFrames = 0;
  private lastTotalFrames = 0;

  reset(): void {
    this.lastSpeechAt = Date.now();
    this.autoStopEmitted = false;
    this.frameBuffer = Buffer.alloc(0);
    this.lastVoicedFrames = 0;
    this.lastTotalFrames = 0;
    this.logConfig();
  }

  track(chunk: Buffer): { speech: boolean; shouldAutoStop: boolean; silenceMs: number } {
    if (this.silenceMs <= 0) {
      return { speech: false, shouldAutoStop: false, silenceMs: this.silenceMs };
    }

    const speech = this.containsSpeech(chunk);
    this.debug(chunk, speech);

    if (speech) {
      this.lastSpeechAt = Date.now();
      return { speech: true, shouldAutoStop: false, silenceMs: this.silenceMs };
    }

    if (!this.autoStopEmitted && Date.now() - this.lastSpeechAt >= this.silenceMs) {
      this.autoStopEmitted = true;
      console.log(`[VAD] auto-stop threshold reached after ${this.silenceMs}ms of silence`);
      return { speech: false, shouldAutoStop: true, silenceMs: this.silenceMs };
    }

    return { speech: false, shouldAutoStop: false, silenceMs: this.silenceMs };
  }

  reactivate(): void {
    this.autoStopEmitted = false;
    this.lastSpeechAt = Date.now();
  }

  private containsSpeech(chunk: Buffer): boolean {
    if (!this.vad) {
      this.lastVoicedFrames = pcm16Rms(chunk) >= vadRmsThreshold() ? 1 : 0;
      this.lastTotalFrames = 1;
      return pcm16Rms(chunk) >= vadRmsThreshold();
    }

    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);
    let voicedFrames = 0;
    let totalFrames = 0;

    while (this.frameBuffer.length >= WEBRTC_FRAME_BYTES) {
      const frame = this.frameBuffer.subarray(0, WEBRTC_FRAME_BYTES);
      this.frameBuffer = this.frameBuffer.subarray(WEBRTC_FRAME_BYTES);
      totalFrames += 1;
      if (this.vad.process(frame)) {
        voicedFrames += 1;
      }
    }

    this.lastVoicedFrames = voicedFrames;
    this.lastTotalFrames = totalFrames;

    if (totalFrames === 0) return false;
    return voicedFrames / totalFrames >= webrtcMinSpeechRatio();
  }

  private debug(chunk: Buffer, speech: boolean): void {
    if (!vadDebugEnabled()) return;

    const now = Date.now();
    if (now - this.lastDebugAt < 1000) return;

    this.lastDebugAt = now;
    const silentForMs = now - this.lastSpeechAt;
    const mode = this.vad ? 'webrtc' : 'rms';
    const ratio = this.lastTotalFrames ? (this.lastVoicedFrames / this.lastTotalFrames).toFixed(2) : '0.00';
    console.log(`[VAD] mode=${mode} speech=${speech} voicedFrames=${this.lastVoicedFrames}/${this.lastTotalFrames} ratio=${ratio} rms=${Math.round(pcm16Rms(chunk))} silentForMs=${silentForMs}`);
  }

  private logConfig(): void {
    const mode = this.vad ? 'webrtc' : 'rms';
    console.log(
      `[VAD] config mode=${mode} autoStopSilenceMs=${this.silenceMs}`
      + ` rmsThreshold=${vadRmsThreshold()}`
      + ` webrtcAggressiveness=${webrtcAggressiveness()}`
      + ` webrtcMinSpeechRatio=${webrtcMinSpeechRatio()}`
    );
  }
}
