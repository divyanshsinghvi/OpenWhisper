/**
 * NemotronStreamingModel.ts
 *
 * NVIDIA Nemotron Speech Streaming via sherpa-onnx OnlineRecognizer.
 * True cache-aware streaming: encoder state persists across audio chunks,
 * so partials emit with low latency as the user speaks.
 *
 * Spawns a long-lived Python server (nemotron_streaming_server.py) that owns
 * the microphone and the recognizer; communicates over stdio with one JSON
 * message per line.
 */

import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';

const execAsync = promisify(exec);

export interface NemotronStreamingEvent {
  type: 'started' | 'partial' | 'final';
  text: string;
  time: number;
}

export class NemotronStreamingModel extends EventEmitter {
  private serverProcess: any = null;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private finalText = '';
  private currentPartial = '';

  private modelDir(): string {
    return path.join(__dirname, '..', '..', 'models', 'nemotron-streaming-en-0.6b-int8');
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execAsync('python3 -c "import sherpa_onnx, sounddevice"');
    } catch {
      return false;
    }
    const required = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'];
    return required.every((f) => fs.existsSync(path.join(this.modelDir(), f)));
  }

  async initialize(): Promise<void> {
    if (this.serverProcess) return;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const { spawn } = require('child_process');
      const serverScript = path.join(__dirname, '..', '..', 'python', 'nemotron_streaming_server.py');
      const mplConfigDir = path.join(__dirname, '..', '..', 'temp', 'matplotlib');
      fs.mkdirSync(mplConfigDir, { recursive: true });

      this.serverProcess = spawn('python3', [serverScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          MPLCONFIGDIR: mplConfigDir,
          NEMOTRON_MODEL_DIR: process.env.NEMOTRON_MODEL_DIR || this.modelDir(),
        },
      });

      const timeout = setTimeout(() => {
        reject(new Error('Nemotron streaming server startup timed out'));
      }, 60000);

      let buffer = '';

      this.serverProcess.stdout.on('data', (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const msg = JSON.parse(line);

            if (msg.status === 'ready') {
              this.ready = true;
              clearTimeout(timeout);
              resolve();
            } else if (msg.status === 'recording') {
              this.emit('recording');
            } else if (msg.status === 'stopped') {
              this.emit('stopped', this.getFullText());
            } else if (msg.type === 'started') {
              this.currentPartial = '';
              this.finalText = '';
              this.emit('transcription', { type: 'started', text: '', time: msg.time });
            } else if (msg.type === 'partial') {
              this.currentPartial = msg.text || '';
              this.emit('transcription', { type: 'partial', text: msg.text, time: msg.time });
            } else if (msg.type === 'final') {
              this.finalText = msg.text || '';
              this.currentPartial = '';
              this.emit('transcription', { type: 'final', text: msg.text, time: msg.time });
            } else if (msg.error) {
              console.error('[NEMOTRON] Server error:', msg.error);
              this.emit('error', msg.error);
            }
          } catch {
            // Ignore non-JSON output.
          }
        }
      });

      this.serverProcess.stderr.on('data', (data: Buffer) => {
        console.log('[NEMOTRON]', data.toString().trim());
      });

      this.serverProcess.on('error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });

      this.serverProcess.on('exit', (code: number) => {
        const wasReady = this.ready;
        this.ready = false;
        this.serverProcess = null;
        if (!wasReady) {
          clearTimeout(timeout);
          reject(new Error(`Nemotron streaming server exited with code ${code}`));
        }
      });
    });

    return this.readyPromise;
  }

  async startStreaming(): Promise<void> {
    if (!this.ready) {
      await this.initialize();
    }
    this.finalText = '';
    this.currentPartial = '';
    this.sendCommand({ command: 'start' });
  }

  async stopStreaming(): Promise<string> {
    return new Promise((resolve) => {
      this.once('stopped', (text: string) => {
        resolve(text);
      });
      this.sendCommand({ command: 'stop' });
      setTimeout(() => {
        resolve(this.getFullText());
      }, 5000);
    });
  }

  getFullText(): string {
    if (this.finalText) {
      return this.finalText.trim();
    }
    return this.currentPartial.trim();
  }

  private sendCommand(cmd: object): void {
    if (this.serverProcess?.stdin?.writable) {
      this.serverProcess.stdin.write(JSON.stringify(cmd) + '\n');
    }
  }

  async cleanup(): Promise<void> {
    if (this.serverProcess) {
      this.sendCommand({ command: 'quit' });
      setTimeout(() => {
        if (this.serverProcess) {
          this.serverProcess.kill('SIGTERM');
          this.serverProcess = null;
        }
      }, 3000);
    }
    this.ready = false;
  }
}
