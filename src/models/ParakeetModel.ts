/**
 * ParakeetModel.ts
 *
 * NVIDIA Parakeet model implementation
 * Supports the unified 0.6B model for offline and streaming-capable ASR.
 *
 * Leaderboard: #1 in speed, competitive accuracy (6.32% WER)
 * Supports: 25 European languages
 *
 * Uses a persistent server process to avoid reloading the model on each transcription
 */

import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { STTModel, TranscriptionOptions, TranscriptionResult, ModelInfo } from './ModelInterface';
import { SettingsManager } from '../settings';

export class ParakeetModel extends STTModel {
  private modelVariant: 'unified' | 'v2' | 'v3';
  private configuredModelName: string;
  private static serverProcess: ChildProcess | null = null;
  private static initPromise: Promise<void> | null = null;
  private static lineBuffer: string = ''; // Buffer for incomplete lines from stdout

  constructor(modelVariant: 'unified' | 'v2' | 'v3' = 'unified') {
    super('parakeet', undefined);
    this.modelVariant = modelVariant;
    this.configuredModelName = process.env.PARAKEET_MODEL_NAME
      || new SettingsManager().get().parakeetModelName
      || 'nvidia/parakeet-tdt-0.6b-v3';
  }

  /**
   * Start the persistent server process
   */
  private static async startServer(): Promise<void> {
    if (ParakeetModel.serverProcess) {
      return; // Already running
    }

    if (ParakeetModel.initPromise) {
      return ParakeetModel.initPromise; // Wait for in-progress init
    }

    ParakeetModel.initPromise = new Promise((resolve, reject) => {
      try {
        const serverScript = path.join(__dirname, '..', '..', 'parakeet_server.py');
        const mplConfigDir = path.join(__dirname, '..', '..', 'temp', 'matplotlib');
        fs.mkdirSync(mplConfigDir, { recursive: true });

        ParakeetModel.serverProcess = spawn('python3', [serverScript], {
          env: {
            ...process.env,
            MPLCONFIGDIR: mplConfigDir,
          },
        });

        let initialized = false;

        ParakeetModel.serverProcess.stdout?.on('data', (data) => {
          const message = data.toString().trim();
          if (message && !initialized) {
            try {
              const json = JSON.parse(message);
              if (json.status === 'ready') {
                initialized = true;
                console.log('[OK] Parakeet server started');
                resolve();
              }
            } catch (e) {
              // Ignore non-JSON output
            }
          }
        });

        ParakeetModel.serverProcess.stderr?.on('data', (data) => {
          console.error('Parakeet server error:', data.toString());
        });

        ParakeetModel.serverProcess.on('error', (error) => {
          ParakeetModel.serverProcess = null;
          ParakeetModel.initPromise = null;
          reject(error);
        });

        ParakeetModel.serverProcess.on('exit', () => {
          ParakeetModel.serverProcess = null;
        });

        // Timeout if server doesn't start (increased timeout for model loading)
        setTimeout(() => {
          if (!initialized) {
            reject(new Error('Parakeet server startup timeout - model may still be loading'));
          }
        }, 60000);
      } catch (error) {
        reject(error);
      }
    });

    return ParakeetModel.initPromise;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      await execAsync('python3 -c "import nemo.collections.asr"');
      return true;
    } catch {
      return false;
    }
  }

  async initialize(): Promise<void> {
    // Start the persistent server process
    await ParakeetModel.startServer();
  }

  async transcribe(
    audioFilePath: string,
    options?: TranscriptionOptions
  ): Promise<TranscriptionResult> {
    const startTime = Date.now();

    // Ensure server is running
    await ParakeetModel.startServer();

    if (!ParakeetModel.serverProcess) {
      throw new Error('Parakeet server process not available');
    }

    const language = options?.language || 'en';
    const modelName = options?.model || this.configuredModelName || (this.modelVariant === 'unified'
      ? 'nvidia/parakeet-unified-en-0.6b'
      : this.modelVariant === 'v3'
        ? 'nvidia/parakeet-tdt-0.6b-v3'  // 25 languages
        : 'nvidia/parakeet-tdt-0.6b-v2'); // English only

    // Send request to server
    return new Promise((resolve, reject) => {
      const request = {
        audio_path: audioFilePath,
        model_name: modelName,
        language: language
      };

      console.log('[DEBUG] Sending transcription request:', request);

      // Set up listener for response (one-time)
      const onData = (data: Buffer) => {
        // Add incoming data to buffer
        ParakeetModel.lineBuffer += data.toString();
        console.log('[DEBUG] Received', data.length, 'bytes. Buffer size:', ParakeetModel.lineBuffer.length);

        // Process complete lines only
        const lines = ParakeetModel.lineBuffer.split('\n');

        // Keep the last incomplete line in buffer (if it doesn't end with \n)
        ParakeetModel.lineBuffer = lines[lines.length - 1];

        // Process all complete lines (all but the last one)
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i];
          if (line.trim()) {
            console.log('[DEBUG] Processing complete line, length:', line.length);
            try {
              const response = JSON.parse(line);
              console.log('[DEBUG] Parsed response, text length:', response.text?.length || 0);
              if (response.error) {
                ParakeetModel.serverProcess?.stdout?.removeListener('data', onData);
                ParakeetModel.lineBuffer = '';
                reject(new Error(response.error));
              } else if (response.text !== undefined) {
                ParakeetModel.serverProcess?.stdout?.removeListener('data', onData);
                ParakeetModel.lineBuffer = '';
                const duration = Date.now() - startTime;
                console.log('[DEBUG] Transcription successful, text:', response.text.substring(0, 100) + (response.text.length > 100 ? '...' : ''));
                resolve({
                  text: response.text,
                  duration,
                  confidence: response.confidence ?? 0.95,
                  language: language,
                });
              }
            } catch (e) {
              console.log('[DEBUG] JSON parse error (might be logging):', (e as Error).message);
              // Ignore parsing errors, might be logging output
            }
          }
        }
      };

      ParakeetModel.serverProcess!.stdout?.on('data', onData);

      // Send request to server
      console.log('[DEBUG] Writing to server stdin');
      ParakeetModel.serverProcess!.stdin?.write(JSON.stringify(request) + '\n');
    });
  }

  getInfo(): ModelInfo {
    return {
      name: this.modelVariant === 'unified'
        ? 'Parakeet Unified EN 0.6B'
        : `Parakeet TDT 0.6B ${this.modelVariant.toUpperCase()}`,
      version: this.configuredModelName,
      type: 'canary', // Using existing type
      speed: 'ultra-fast',
      accuracy: 'excellent',
      sizeCategory: 'small',
      languages: this.modelVariant === 'v3'
        ? ['en', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'nl', 'ro', 'cs', 'sk', 'bg', 'hr', 'sl', 'sr', 'mk', 'uk', 'be', 'et', 'lv', 'lt', 'mt', 'ga', 'cy'] // 25 languages
        : ['en'],
      requiresGPU: false, // Can run on CPU, but GPU recommended for max speed
      estimatedMemory: '600MB',
      rtfSpeed: this.modelVariant === 'unified' ? 100 : 3333,
    };
  }

  async cleanup(): Promise<void> {
    // Shut down the server process
    if (ParakeetModel.serverProcess) {
      ParakeetModel.serverProcess.kill();
      ParakeetModel.serverProcess = null;
      ParakeetModel.initPromise = null;
    }
  }
}
