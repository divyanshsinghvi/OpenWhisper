/**
 * ParakeetStreamingModel.ts
 *
 * NVIDIA Parakeet Unified streaming transcription using a persistent Python
 * server. The server captures mic audio and emits partial/final transcripts.
 */

import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';
import { SettingsManager } from '../settings';

const execAsync = promisify(exec);

export interface ParakeetStreamingEvent {
  type: 'started' | 'partial' | 'final';
  text: string;
  time: number;
}

export class ParakeetStreamingModel extends EventEmitter {
  private serverProcess: any = null;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private finalTexts: string[] = [];
  private currentPartial = '';

  async isAvailable(): Promise<boolean> {
    try {
      await execAsync('python3 -c "import nemo.collections.asr, sounddevice, soundfile"');
      return true;
    } catch {
      return false;
    }
  }

  async initialize(): Promise<void> {
    if (this.serverProcess) return;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const { spawn } = require('child_process');
      const settings = new SettingsManager().get();
      const serverScript = path.join(__dirname, '..', '..', 'parakeet_streaming_server.py');
      const mplConfigDir = path.join(__dirname, '..', '..', 'temp', 'matplotlib');

      fs.mkdirSync(mplConfigDir, { recursive: true });

      this.serverProcess = spawn('python3', [serverScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          MPLCONFIGDIR: mplConfigDir,
          PARAKEET_MODEL_NAME: process.env.PARAKEET_MODEL_NAME || settings.parakeetModelName,
        },
      });

      const timeout = setTimeout(() => {
        reject(new Error('Parakeet streaming server startup timed out'));
      }, 180000);

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
              this.emit('transcription', { type: 'started', text: msg.text, time: msg.time });
            } else if (msg.type === 'partial') {
              this.currentPartial = msg.text;
              this.emit('transcription', { type: 'partial', text: msg.text, time: msg.time });
            } else if (msg.type === 'final') {
              this.finalTexts = [msg.text];
              this.currentPartial = '';
              this.emit('transcription', { type: 'final', text: msg.text, time: msg.time });
            } else if (msg.error) {
              console.error('[PARAKEET] Server error:', msg.error);
              this.emit('error', msg.error);
            }
          } catch {
            // Ignore non-JSON output.
          }
        }
      });

      this.serverProcess.stderr.on('data', (data: Buffer) => {
        console.log('[PARAKEET]', data.toString().trim());
      });

      this.serverProcess.on('error', (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });

      this.serverProcess.on('exit', (code: number) => {
        this.ready = false;
        this.serverProcess = null;
        if (!this.ready) {
          clearTimeout(timeout);
          reject(new Error(`Parakeet streaming server exited with code ${code}`));
        }
      });
    });

    return this.readyPromise;
  }

  async startStreaming(): Promise<void> {
    if (!this.ready) {
      await this.initialize();
    }

    this.finalTexts = [];
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
    if (this.currentPartial) {
      return this.currentPartial.trim();
    }

    return this.finalTexts.join(' ').trim();
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
