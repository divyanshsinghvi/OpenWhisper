/**
 * MoonshineStreamingModel.ts
 *
 * Moonshine v2 streaming transcription using moonshine-voice SDK.
 * Spawns a persistent Python server that listens to the mic directly
 * and sends partial transcription results in real-time.
 */

import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';

const execAsync = promisify(exec);

export interface StreamingEvent {
  type: 'started' | 'partial' | 'final';
  text: string;
  time: number;
}

export class MoonshineStreamingModel extends EventEmitter {
  private serverProcess: any = null;
  private ready: boolean = false;
  private readyPromise: Promise<void> | null = null;
  private finalTexts: string[] = [];
  private currentPartial: string = '';

  async isAvailable(): Promise<boolean> {
    try {
      await execAsync('python3 -c "import moonshine_voice"');
      return true;
    } catch {
      return false;
    }
  }

  async initialize(): Promise<void> {
    if (this.serverProcess) return;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const { spawn } = require('child_process');
      const serverScript = path.join(__dirname, '..', '..', 'moonshine_streaming_server.py');

      this.serverProcess = spawn('python3', [serverScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const timeout = setTimeout(() => {
        reject(new Error('Moonshine streaming server startup timed out'));
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
              this.emit('transcription', { type: 'started', text: msg.text, time: msg.time });
            } else if (msg.type === 'partial') {
              this.currentPartial = msg.text;
              this.emit('transcription', { type: 'partial', text: msg.text, time: msg.time });
            } else if (msg.type === 'final') {
              this.finalTexts.push(msg.text);
              this.currentPartial = '';
              this.emit('transcription', { type: 'final', text: msg.text, time: msg.time });
            } else if (msg.error) {
              console.error('[MOONSHINE] Server error:', msg.error);
              this.emit('error', msg.error);
            }
          } catch (e) {
            // Ignore non-JSON output
          }
        }
      });

      this.serverProcess.stderr.on('data', (data: Buffer) => {
        console.log('[MOONSHINE]', data.toString().trim());
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
          reject(new Error(`Moonshine server exited with code ${code}`));
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

      // Fallback timeout in case stopped event doesn't fire
      setTimeout(() => {
        resolve(this.getFullText());
      }, 2000);
    });
  }

  getFullText(): string {
    const parts = [...this.finalTexts];
    if (this.currentPartial) {
      parts.push(this.currentPartial);
    }
    return parts.join(' ').trim();
  }

  getCurrentPartial(): string {
    return this.currentPartial;
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
