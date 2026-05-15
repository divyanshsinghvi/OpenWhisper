/**
 * AudioChunker.ts
 *
 * Splits long audio files into smaller chunks for batch transcription
 * Handles chunking strategy to avoid cutting mid-word
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface AudioChunk {
  path: string;
  index: number;
  startTime: number;  // seconds
  duration: number;   // seconds
}

export class AudioChunker {
  private chunkDuration: number;  // seconds
  private overlapDuration: number; // seconds (overlap to avoid cutting words)

  constructor(chunkDuration: number = 30, overlapDuration: number = 1) {
    this.chunkDuration = chunkDuration;
    this.overlapDuration = overlapDuration;
  }

  /**
   * Get audio duration using ffprobe or sox
   */
  async getAudioDuration(audioPath: string): Promise<number> {
    try {
      // Try ffprobe first (more accurate)
      const { stdout } = await execAsync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
      );
      return parseFloat(stdout.trim());
    } catch (error) {
      // Fallback to sox
      try {
        const { stdout } = await execAsync(`soxi -D "${audioPath}"`);
        return parseFloat(stdout.trim());
      } catch (soxError) {
        throw new Error('Could not determine audio duration. Install ffmpeg or sox.');
      }
    }
  }

  /**
   * Split audio file into chunks
   */
  async splitAudio(audioPath: string, outputDir?: string): Promise<AudioChunk[]> {
    if (!fs.existsSync(audioPath)) {
      throw new Error(`Audio file not found: ${audioPath}`);
    }

    // Create output directory
    const outDir = outputDir || path.join(path.dirname(audioPath), 'chunks');
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    // Get total duration
    const totalDuration = await this.getAudioDuration(audioPath);
    console.log(`[AudioChunker] Total duration: ${totalDuration.toFixed(2)}s`);

    // If audio is shorter than chunk duration, no need to split
    if (totalDuration <= this.chunkDuration) {
      return [{
        path: audioPath,
        index: 0,
        startTime: 0,
        duration: totalDuration
      }];
    }

    // Calculate number of chunks
    const numChunks = Math.ceil(totalDuration / (this.chunkDuration - this.overlapDuration));
    console.log(`[AudioChunker] Splitting into ${numChunks} chunks...`);

    const chunks: AudioChunk[] = [];

    for (let i = 0; i < numChunks; i++) {
      const startTime = i * (this.chunkDuration - this.overlapDuration);
      const duration = Math.min(this.chunkDuration, totalDuration - startTime);

      const chunkPath = path.join(outDir, `chunk_${i.toString().padStart(4, '0')}.wav`);

      // Use ffmpeg or sox to extract chunk
      await this.extractChunk(audioPath, chunkPath, startTime, duration);

      chunks.push({
        path: chunkPath,
        index: i,
        startTime,
        duration
      });

      console.log(`[AudioChunker] Created chunk ${i + 1}/${numChunks}: ${startTime.toFixed(1)}s - ${(startTime + duration).toFixed(1)}s`);
    }

    return chunks;
  }

  /**
   * Extract a chunk from audio file using ffmpeg or sox
   */
  private async extractChunk(
    inputPath: string,
    outputPath: string,
    startTime: number,
    duration: number
  ): Promise<void> {
    try {
      // Try ffmpeg first (more reliable)
      await execAsync(
        `ffmpeg -i "${inputPath}" -ss ${startTime} -t ${duration} -ar 16000 -ac 1 -y "${outputPath}" 2>/dev/null`
      );
    } catch (error) {
      // Fallback to sox
      try {
        await execAsync(
          `sox "${inputPath}" "${outputPath}" trim ${startTime} ${duration}`
        );
      } catch (soxError) {
        throw new Error('Could not extract audio chunk. Install ffmpeg or sox.');
      }
    }
  }

  /**
   * Clean up chunk files
   */
  async cleanup(chunks: AudioChunk[]): Promise<void> {
    for (const chunk of chunks) {
      if (fs.existsSync(chunk.path)) {
        fs.unlinkSync(chunk.path);
      }
    }

    // Remove chunk directory if empty
    const chunkDir = path.dirname(chunks[0]?.path);
    if (chunkDir && fs.existsSync(chunkDir)) {
      const files = fs.readdirSync(chunkDir);
      if (files.length === 0) {
        fs.rmdirSync(chunkDir);
      }
    }
  }
}
