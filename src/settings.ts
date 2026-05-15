/**
 * settings.ts
 *
 * Settings manager for Listen
 * Handles configuration persistence and validation
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export interface ListenSettings {
  // General
  language: string;
  autoStart: boolean;
  minimizeToTray: boolean;

  // Recording
  recordingMode: 'toggle' | 'push-to-talk' | 'continuous' | 'vad';
  audioQuality: 'low' | 'medium' | 'high';
  noiseReduction: boolean;

  // Hotkeys
  hotkeys: {
    toggleRecording: string;
    cancelRecording: string;
    showSettings: string;
    showHistory: string;
  };

  // Model
  preferredModel: string | 'auto';
  transcriptionEngine: 'moonshine-streaming' | 'parakeet-streaming' | 'parakeet' | 'auto';
  parakeetModelName: string;
  modelPriority: 'speed' | 'accuracy' | 'balance';
  enableStreaming: boolean;

  // Post-processing
  autoCapitalize: boolean;
  autoPunctuation: boolean;
  enableVoiceCommands: boolean;
  customVocabulary: string[];

  // Privacy
  saveHistory: boolean;
  historyLimit: number;
  saveTrainingData: boolean;
  datasetDirectory: string;
  autoDelete: boolean;
  autoDeleteDays: number;

  // UI
  theme: 'light' | 'dark' | 'system';
  overlayOpacity: number;
  showNotifications: boolean;

  // Advanced
  apiServerMode: boolean;
  apiServerPort: number;
  enableTelemetry: boolean;
}

export class SettingsManager {
  private settings: ListenSettings;
  private settingsPath: string;

  constructor() {
    this.settingsPath = path.join(
      app.getPath('userData'),
      'settings.json'
    );

    this.settings = this.loadSettings();
  }

  private getDefaultSettings(): ListenSettings {
    return {
      // General
      language: 'en',
      autoStart: false,
      minimizeToTray: true,

      // Recording
      recordingMode: 'toggle',
      audioQuality: 'medium',
      noiseReduction: false,

      // Hotkeys
      hotkeys: {
        toggleRecording: 'CommandOrControl+Shift+Space',
        cancelRecording: 'Escape',
        showSettings: 'CommandOrControl+,',
        showHistory: 'CommandOrControl+H'
      },

      // Model
      preferredModel: 'auto',
      transcriptionEngine: 'auto',
      parakeetModelName: 'nvidia/parakeet-tdt-0.6b-v3',
      modelPriority: 'balance',
      enableStreaming: false,

      // Post-processing
      autoCapitalize: true,
      autoPunctuation: false,
      enableVoiceCommands: true,
      customVocabulary: [],

      // Privacy
      saveHistory: true,
      historyLimit: 100,
      saveTrainingData: true,
      datasetDirectory: '',
      autoDelete: false,
      autoDeleteDays: 30,

      // UI
      theme: 'system',
      overlayOpacity: 0.95,
      showNotifications: true,

      // Advanced
      apiServerMode: false,
      apiServerPort: 8765,
      enableTelemetry: false
    };
  }

  private loadSettings(): ListenSettings {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const data = fs.readFileSync(this.settingsPath, 'utf-8');
        const loaded = JSON.parse(data);

        // Merge with defaults to handle new settings
        return { ...this.getDefaultSettings(), ...loaded };
      }
    } catch (error) {
      console.error('Failed to load settings:', error);
    }

    return this.getDefaultSettings();
  }

  saveSettings(): void {
    try {
      const dir = path.dirname(this.settingsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(
        this.settingsPath,
        JSON.stringify(this.settings, null, 2),
        'utf-8'
      );
    } catch (error) {
      console.error('Failed to save settings:', error);
    }
  }

  get(): ListenSettings {
    return { ...this.settings };
  }

  set(newSettings: Partial<ListenSettings>): void {
    this.settings = { ...this.settings, ...newSettings };
    this.saveSettings();
  }

  reset(): void {
    this.settings = this.getDefaultSettings();
    this.saveSettings();
  }

  // Specific getters
  getHotkey(action: keyof ListenSettings['hotkeys']): string {
    return this.settings.hotkeys[action];
  }

  setHotkey(action: keyof ListenSettings['hotkeys'], hotkey: string): void {
    this.settings.hotkeys[action] = hotkey;
    this.saveSettings();
  }

  addCustomWord(word: string): void {
    if (!this.settings.customVocabulary.includes(word)) {
      this.settings.customVocabulary.push(word);
      this.saveSettings();
    }
  }

  removeCustomWord(word: string): void {
    this.settings.customVocabulary = this.settings.customVocabulary.filter(
      w => w !== word
    );
    this.saveSettings();
  }
}
