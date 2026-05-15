/**
 * MeetingTranscriber.ts
 *
 * Handles batch transcription of long meeting recordings
 * Provides progress updates and manages chunk processing
 */

import { AudioChunker, AudioChunk } from './AudioChunker';
import { ModelRouter } from './models/ModelRouter';
import { TranscriptionResult } from './models/ModelInterface';

export interface TranscriptSegment {
  text: string;
  startTime: number;  // seconds
  endTime: number;    // seconds
  confidence?: number;
}

export interface MeetingTranscript {
  segments: TranscriptSegment[];
  fullText: string;
  duration: number;
  processingTime: number;
  modelUsed: string;
  timestamp: number;
}

export type ProgressCallback = (
  current: number,
  total: number,
  currentText: string,
  percent: number
) => void;

export class MeetingTranscriber {
  private chunker: AudioChunker;
  private router: ModelRouter;

  constructor(chunkDuration: number = 30) {
    this.chunker = new AudioChunker(chunkDuration, 1); // 1 second overlap
    this.router = new ModelRouter();
  }

  /**
   * Initialize the transcription router
   */
  async initialize(): Promise<void> {
    await this.router.initialize();
  }

  /**
   * Transcribe a long meeting recording with progress updates
   */
  async transcribeMeeting(
    audioPath: string,
    onProgress?: ProgressCallback
  ): Promise<MeetingTranscript> {
    const startTime = Date.now();

    console.log('[MeetingTranscriber] Starting meeting transcription...');

    // Get audio duration first
    const totalDuration = await this.chunker.getAudioDuration(audioPath);
    console.log(`[MeetingTranscriber] Audio duration: ${totalDuration.toFixed(2)}s`);

    // Split into chunks
    const chunks = await this.chunker.splitAudio(audioPath);
    console.log(`[MeetingTranscriber] Split into ${chunks.length} chunks`);

    // Transcribe each chunk
    const segments: TranscriptSegment[] = [];
    let modelUsed = 'unknown';

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      // Update progress
      const percent = Math.round(((i + 1) / chunks.length) * 100);
      console.log(`[MeetingTranscriber] Processing chunk ${i + 1}/${chunks.length} (${percent}%)`);

      try {
        // Transcribe chunk
        const result = await this.router.transcribe(chunk.path, {}, {
          priority: 'balance',
          platform: 'desktop'
        });

        modelUsed = result.modelUsed || modelUsed;

        // Add segment if there's text
        if (result.text.trim()) {
          segments.push({
            text: result.text.trim(),
            startTime: chunk.startTime,
            endTime: chunk.startTime + chunk.duration,
            confidence: result.confidence
          });
        }

        // Call progress callback
        if (onProgress) {
          onProgress(i + 1, chunks.length, result.text, percent);
        }

      } catch (error) {
        console.error(`[MeetingTranscriber] Error transcribing chunk ${i}:`, error);

        // Add error marker
        segments.push({
          text: '[Transcription error in this segment]',
          startTime: chunk.startTime,
          endTime: chunk.startTime + chunk.duration,
          confidence: 0
        });
      }
    }

    // Clean up chunk files
    await this.chunker.cleanup(chunks);

    // Merge segments into full text
    const fullText = this.mergeSegments(segments);

    const processingTime = Date.now() - startTime;
    console.log(`[MeetingTranscriber] Completed in ${(processingTime / 1000).toFixed(2)}s`);

    return {
      segments,
      fullText,
      duration: totalDuration,
      processingTime,
      modelUsed,
      timestamp: Date.now()
    };
  }

  /**
   * Merge segments into full text, handling overlaps
   */
  private mergeSegments(segments: TranscriptSegment[]): string {
    if (segments.length === 0) return '';
    if (segments.length === 1) return segments[0].text;

    // Simple merge: join with spaces, remove duplicate sentences at boundaries
    const texts = segments.map(s => s.text.trim());

    // TODO: Implement smarter overlap detection
    // For now, just join with newlines to preserve segment boundaries
    return texts.join('\n\n');
  }

  /**
   * Format transcript with timestamps
   */
  formatTranscriptWithTimestamps(transcript: MeetingTranscript): string {
    let output = '';

    for (const segment of transcript.segments) {
      const timestamp = this.formatTimestamp(segment.startTime);
      output += `[${timestamp}] ${segment.text}\n\n`;
    }

    return output;
  }

  /**
   * Format seconds to MM:SS or HH:MM:SS
   */
  private formatTimestamp(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }
  }

  /**
   * Export transcript to markdown format
   */
  exportToMarkdown(transcript: MeetingTranscript, title?: string): string {
    const date = new Date(transcript.timestamp);
    const dateStr = date.toLocaleString();

    let markdown = `# ${title || 'Meeting Transcript'}\n\n`;
    markdown += `**Date:** ${dateStr}\n`;
    markdown += `**Duration:** ${this.formatTimestamp(transcript.duration)}\n`;
    markdown += `**Model:** ${transcript.modelUsed}\n\n`;
    markdown += `---\n\n`;
    markdown += `## Transcript\n\n`;

    for (const segment of transcript.segments) {
      const timestamp = this.formatTimestamp(segment.startTime);
      markdown += `**[${timestamp}]** ${segment.text}\n\n`;
    }

    return markdown;
  }

  /**
   * Export transcript to plain text
   */
  exportToText(transcript: MeetingTranscript): string {
    return this.formatTranscriptWithTimestamps(transcript);
  }
}
