/**
 * dataset.ts
 *
 * Dataset management for collecting training data
 * Saves recordings + transcriptions for future model training
 */

import * as fs from 'fs';
import * as path from 'path';

export interface DatasetEntry {
  audioFile: string;
  transcription: string;
  confidence: number;
  model: string;
  language: string;
  timestamp: number;
  duration: number; // in ms
  fileSize: number; // in bytes
}

export class DatasetManager {
  private datasetDir: string;

  constructor(datasetDir?: string) {
    this.datasetDir = datasetDir || process.env.OPENWHISPER_DATASET_DIR || this.getDefaultDatasetDir();

    if (!fs.existsSync(this.datasetDir)) {
      fs.mkdirSync(this.datasetDir, { recursive: true });
      console.log(`[DIR] Dataset directory created: ${this.datasetDir}`);
    }
  }

  private getDefaultDatasetDir(): string {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const googleDriveDir = this.findGoogleDriveDir(home);

    if (googleDriveDir) {
      return path.join(googleDriveDir, 'OpenWhisper', 'training-data');
    }

    return path.join(home, '.listen', 'dataset');
  }

  private findGoogleDriveDir(home: string): string | null {
    const cloudStorageDir = path.join(home, 'Library', 'CloudStorage');

    try {
      if (fs.existsSync(cloudStorageDir)) {
        const googleDrive = fs.readdirSync(cloudStorageDir)
          .find(entry => entry.startsWith('GoogleDrive'));

        if (googleDrive) {
          const basePath = path.join(cloudStorageDir, googleDrive);
          const myDrivePath = path.join(basePath, 'My Drive');
          return fs.existsSync(myDrivePath) ? myDrivePath : basePath;
        }
      }
    } catch (error) {
      console.log('[WARN] Could not inspect Google Drive CloudStorage directory:', error);
    }

    const legacyPath = path.join(home, 'Google Drive');
    return fs.existsSync(legacyPath) ? legacyPath : null;
  }

  /**
   * Save a transcription entry to the dataset
   */
  async saveEntry(audioPath: string, data: Omit<DatasetEntry, 'audioFile' | 'timestamp'>) {
    try {
      const timestamp = Date.now();
      const filename = `recording_${timestamp}`;

      // Create unique filenames
      const wavFile = `${filename}.wav`;
      const txtFile = `${filename}.txt`;
      const jsonFile = `${filename}.json`;

      const wavPath = path.join(this.datasetDir, wavFile);
      const txtPath = path.join(this.datasetDir, txtFile);
      const jsonPath = path.join(this.datasetDir, jsonFile);

      // Copy WAV file
      if (fs.existsSync(audioPath)) {
        fs.copyFileSync(audioPath, wavPath);
        console.log(`[OK] Audio saved: ${wavFile}`);
      } else {
        throw new Error(`Audio file not found: ${audioPath}`);
      }

      // Save transcription as text
      fs.writeFileSync(txtPath, data.transcription, 'utf-8');
      console.log(`[OK] Transcription saved: ${txtFile}`);

      // Save metadata as JSON
      const entry: DatasetEntry = {
        audioFile: wavFile,
        timestamp,
        ...data
      };

      fs.writeFileSync(jsonPath, JSON.stringify(entry, null, 2), 'utf-8');
      console.log(`[OK] Metadata saved: ${jsonFile}`);

      const manifestPath = path.join(this.datasetDir, 'manifest.jsonl');
      fs.appendFileSync(manifestPath, JSON.stringify({
        audio_filepath: wavPath,
        text: data.transcription,
        duration: data.duration / 1000,
        model: data.model,
        language: data.language,
        confidence: data.confidence,
        timestamp,
      }) + '\n', 'utf-8');
      console.log('[OK] Manifest updated: manifest.jsonl');

      console.log(`\n[ENTRY] Dataset Entry Added:`);
      console.log(`  Text: "${data.transcription}"`);
      console.log(`  Model: ${data.model}`);
      console.log(`  Confidence: ${(data.confidence * 100).toFixed(1)}%`);
      console.log(`  File Size: ${(data.fileSize / 1024).toFixed(2)} KB`);
      console.log(`  Duration: ${(data.duration / 1000).toFixed(2)}s`);

      return entry;
    } catch (error) {
      console.error('[ERROR] Error saving dataset entry:', error);
      throw error;
    }
  }

  /**
   * Get dataset statistics
   */
  getStats() {
    try {
      const files = fs.readdirSync(this.datasetDir);
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      const totalWavSize = files
        .filter(f => f.endsWith('.wav'))
        .reduce((total, f) => {
          const filePath = path.join(this.datasetDir, f);
          return total + fs.statSync(filePath).size;
        }, 0);

      return {
        entriesCount: jsonFiles.length,
        totalAudioSize: totalWavSize,
        datasetDir: this.datasetDir,
        files: files.length
      };
    } catch (error) {
      console.error('[ERROR] Error getting stats:', error);
      return null;
    }
  }

  /**
   * List all dataset entries
   */
  listEntries() {
    try {
      const files = fs.readdirSync(this.datasetDir);
      const entries: DatasetEntry[] = [];

      for (const file of files) {
        if (file.endsWith('.json')) {
          const jsonPath = path.join(this.datasetDir, file);
          const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
          entries.push(data);
        }
      }

      return entries.sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      console.error('[ERROR] Error listing entries:', error);
      return [];
    }
  }

  /**
   * Export dataset as CSV for analysis
   */
  exportAsCSV(outputPath?: string) {
    try {
      const entries = this.listEntries();
      const csvPath = outputPath || path.join(this.datasetDir, 'export.csv');

      const headers = ['timestamp', 'transcription', 'confidence', 'model', 'language', 'duration_ms', 'file_size_bytes'];
      const rows = entries.map(entry => [
        new Date(entry.timestamp).toISOString(),
        `"${entry.transcription.replace(/"/g, '""')}"`, // Escape quotes
        entry.confidence,
        entry.model,
        entry.language,
        entry.duration,
        entry.fileSize
      ]);

      const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
      fs.writeFileSync(csvPath, csv, 'utf-8');

      console.log(`[OK] Dataset exported to: ${csvPath}`);
      console.log(`  Entries: ${entries.length}`);
      console.log(`  Size: ${(csv.length / 1024).toFixed(2)} KB`);

      return csvPath;
    } catch (error) {
      console.error('[ERROR] Error exporting CSV:', error);
      throw error;
    }
  }

  /**
   * Get dataset directory path
   */
  getDatasetDir(): string {
    return this.datasetDir;
  }
}
