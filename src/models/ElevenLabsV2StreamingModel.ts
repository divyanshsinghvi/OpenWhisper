/**
 * ElevenLabsV2StreamingModel.ts
 *
 * ElevenLabs Scribe v2 realtime transcription.
 * Streams 16 kHz mono PCM over WebSocket and exposes the same event shape as
 * the local streaming engines.
 */

import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import WebSocket from 'ws';
import { LocalSpeechActivityTracker } from './LocalSpeechActivityTracker';

export interface ElevenLabsV2StreamingEvent {
  type: 'started' | 'partial' | 'final';
  text: string;
  time: number;
}

type AudioBackend = {
  command: string;
  args: string[];
};

const SAMPLE_RATE = 16000;

function elevenLabsApiKey(): string {
  return process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY || '';
}

function audioBackend(): AudioBackend {
  if (process.platform === 'linux') {
    return {
      command: 'arecord',
      args: ['-q', '-f', 'S16_LE', '-t', 'raw', '-D', 'default', '-r', String(SAMPLE_RATE), '-c', '1'],
    };
  }

  return {
    command: 'rec',
    args: ['-q', '-r', String(SAMPLE_RATE), '-c', '1', '-b', '16', '-e', 'signed-integer', '-t', 'raw', '-'],
  };
}

function transcriptText(message: any): string {
  return String(
    message.text
    || message.transcript
    || message.partial_transcript
    || message.committed_transcript
    || message.partial
    || message.final
    || ''
  );
}

export class ElevenLabsV2StreamingModel extends EventEmitter {
  private ready = false;
  private ws: WebSocket | null = null;
  private recordingProcess: any = null;
  private finalTexts: string[] = [];
  private currentPartial = '';
  private stopTimer: NodeJS.Timeout | null = null;
  private speechActivityTracker = new LocalSpeechActivityTracker();
  private cloudPaused = false;
  private reconnecting = false;

  async isAvailable(): Promise<boolean> {
    return Boolean(elevenLabsApiKey());
  }

  async initialize(): Promise<void> {
    if (!elevenLabsApiKey()) {
      throw new Error('ELEVENLABS_API_KEY is required for ElevenLabs v2 transcription');
    }

    this.ready = true;
  }

  async startStreaming(): Promise<void> {
    if (!this.ready) {
      await this.initialize();
    }

    this.finalTexts = [];
    this.currentPartial = '';
    this.cloudPaused = false;
    this.reconnecting = false;
    this.speechActivityTracker.reset();
    await this.connect();
    this.startAudioCapture();

    this.emit('recording');
    this.emit('transcription', { type: 'started', text: '', time: Date.now() });
  }

  async stopStreaming(): Promise<string> {
    if (this.recordingProcess) {
      this.recordingProcess.kill('SIGINT');
      this.recordingProcess = null;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: '',
        sample_rate: SAMPLE_RATE,
        commit: true,
      }));
    }

    return new Promise((resolve) => {
      this.stopTimer = setTimeout(() => {
        this.closeWebSocket();
        this.emit('stopped', this.getFullText());
        resolve(this.getFullText());
      }, 1200);
    });
  }

  getFullText(): string {
    const parts = [...this.finalTexts];
    if (this.currentPartial) {
      parts.push(this.currentPartial);
    }
    return parts.join(' ').trim();
  }

  private appendFinalText(text: string): void {
    const cleaned = text.trim();
    if (!cleaned) return;

    const last = this.finalTexts[this.finalTexts.length - 1]?.trim();
    if (last === cleaned) return;

    this.finalTexts.push(cleaned);
  }

  async cleanup(): Promise<void> {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }

    if (this.recordingProcess) {
      this.recordingProcess.kill('SIGKILL');
      this.recordingProcess = null;
    }

    this.closeWebSocket();
    this.ready = false;
  }

  private pauseCloudForSilence(silenceMs: number): void {
    if (this.cloudPaused) return;

    this.cloudPaused = true;
    const committedPartial = this.currentPartial.trim();
    this.appendFinalText(committedPartial);
    this.currentPartial = '';
    if (committedPartial) {
      this.emit('transcription', { type: 'final', text: committedPartial, time: Date.now() });
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: '',
        sample_rate: SAMPLE_RATE,
        commit: true,
      }));
    }
    this.closeWebSocket();
    this.emit('auto-stop', { reason: 'silence', silenceMs });
  }

  private async resumeCloudAfterSpeech(): Promise<void> {
    if (!this.cloudPaused || this.reconnecting) return;

    this.reconnecting = true;
    try {
      await this.connect();
      this.cloudPaused = false;
      this.speechActivityTracker.reactivate();
      this.emit('auto-resume', { reason: 'speech' });
    } catch (error) {
      this.emit('error', `ElevenLabs reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.reconnecting = false;
    }
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL('wss://api.elevenlabs.io/v1/speech-to-text/realtime');
      url.searchParams.set('model_id', 'scribe_v2_realtime');
      url.searchParams.set('commit_strategy', 'vad');

      const ws = new WebSocket(url.toString(), {
        headers: { 'xi-api-key': elevenLabsApiKey() },
      });
      this.ws = ws;

      const timeout = setTimeout(() => {
        reject(new Error('ElevenLabs realtime WebSocket startup timed out'));
      }, 15000);

      ws.on('open', () => {
        clearTimeout(timeout);
        resolve();
      });

      ws.on('message', (data: WebSocket.RawData) => {
        this.handleMessage(data.toString());
      });

      ws.on('error', (error: Error) => {
        clearTimeout(timeout);
        this.emit('error', error.message);
        reject(error);
      });

      ws.on('close', () => {
        this.ws = null;
      });
    });
  }

  private handleMessage(raw: string): void {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    const messageType = String(message.message_type || message.type || message.event || '');
    const text = transcriptText(message);

    if (message.error || messageType === 'error') {
      this.emit('error', message.error || message.message || raw);
      return;
    }

    if (messageType === 'partial_transcript' || messageType === 'partial') {
      this.currentPartial = text;
      this.emit('transcription', { type: 'partial', text, time: Date.now() });
      return;
    }

    if (
      messageType === 'committed_transcript'
      || messageType === 'final_transcript'
      || messageType === 'final'
    ) {
      if (text) {
        this.appendFinalText(text);
      }
      this.currentPartial = '';
      this.emit('transcription', { type: 'final', text, time: Date.now() });
    }
  }

  private startAudioCapture(): void {
    const backend = audioBackend();
    this.recordingProcess = spawn(backend.command, backend.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.recordingProcess.stdout?.on('data', (chunk: Buffer) => {
      this.trackLocalAudioActivity(chunk);
      if (this.cloudPaused || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      this.ws.send(JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: chunk.toString('base64'),
        sample_rate: SAMPLE_RATE,
        commit: false,
      }));
    });

    this.recordingProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) console.log('[ELEVENLABS]', text);
    });

    this.recordingProcess.on('error', (error: Error) => {
      this.emit('error', `Audio capture failed: ${error.message}`);
    });

    this.recordingProcess.on('exit', () => {
      this.recordingProcess = null;
    });
  }

  private closeWebSocket(): void {
    if (!this.ws) return;

    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
    this.ws = null;
  }

  private trackLocalAudioActivity(chunk: Buffer): void {
    const result = this.speechActivityTracker.track(chunk);
    if (result.shouldAutoStop) {
      this.pauseCloudForSilence(result.silenceMs);
      return;
    }

    if (result.speech && this.cloudPaused) {
      void this.resumeCloudAfterSpeech();
    }
  }
}
