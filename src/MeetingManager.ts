/**
 * MeetingManager.ts
 *
 * Manages meeting recordings, transcripts, and history
 * Handles saving, loading, and exporting meetings
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { MeetingTranscript } from './MeetingTranscriber';

export interface MeetingRecord {
  id: string;
  title: string;
  timestamp: number;
  duration: number;
  audioPath?: string;  // Optional: keep original audio
  transcript: MeetingTranscript;
  summary?: string;    // AI-generated summary (Phase 3)
  tags?: string[];
}

export class MeetingManager {
  private meetingsDir: string;
  private indexPath: string;
  private meetings: Map<string, MeetingRecord> = new Map();

  constructor() {
    const userDataPath = app.getPath('userData');
    this.meetingsDir = path.join(userDataPath, 'meetings');
    this.indexPath = path.join(this.meetingsDir, 'index.json');

    this.initializeStorage();
    this.loadIndex();
  }

  /**
   * Initialize storage directories
   */
  private initializeStorage(): void {
    if (!fs.existsSync(this.meetingsDir)) {
      fs.mkdirSync(this.meetingsDir, { recursive: true });
    }
  }

  /**
   * Load meeting index
   */
  private loadIndex(): void {
    try {
      if (fs.existsSync(this.indexPath)) {
        const data = fs.readFileSync(this.indexPath, 'utf-8');
        const index = JSON.parse(data);

        for (const record of index) {
          this.meetings.set(record.id, record);
        }

        console.log(`[MeetingManager] Loaded ${this.meetings.size} meetings`);
      }
    } catch (error) {
      console.error('[MeetingManager] Failed to load index:', error);
    }
  }

  /**
   * Save meeting index
   */
  private saveIndex(): void {
    try {
      const index = Array.from(this.meetings.values());
      fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2), 'utf-8');
    } catch (error) {
      console.error('[MeetingManager] Failed to save index:', error);
    }
  }

  /**
   * Generate unique meeting ID
   */
  private generateId(): string {
    return `meeting_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Save a new meeting
   */
  saveMeeting(
    transcript: MeetingTranscript,
    title?: string,
    audioPath?: string,
    keepAudio: boolean = false
  ): MeetingRecord {
    const id = this.generateId();
    const meetingTitle = title || `Meeting ${new Date().toLocaleString()}`;

    // Copy audio file if requested
    let savedAudioPath: string | undefined;
    if (keepAudio && audioPath && fs.existsSync(audioPath)) {
      savedAudioPath = path.join(this.meetingsDir, `${id}.wav`);
      fs.copyFileSync(audioPath, savedAudioPath);
    }

    const record: MeetingRecord = {
      id,
      title: meetingTitle,
      timestamp: transcript.timestamp,
      duration: transcript.duration,
      audioPath: savedAudioPath,
      transcript
    };

    // Save meeting record
    this.meetings.set(id, record);
    this.saveIndex();

    // Save full transcript to separate file
    const transcriptPath = path.join(this.meetingsDir, `${id}.json`);
    fs.writeFileSync(transcriptPath, JSON.stringify(record, null, 2), 'utf-8');

    console.log(`[MeetingManager] Saved meeting: ${meetingTitle}`);

    return record;
  }

  /**
   * Get meeting by ID
   */
  getMeeting(id: string): MeetingRecord | undefined {
    return this.meetings.get(id);
  }

  /**
   * Get all meetings
   */
  getAllMeetings(): MeetingRecord[] {
    return Array.from(this.meetings.values())
      .sort((a, b) => b.timestamp - a.timestamp); // Most recent first
  }

  /**
   * Get recent meetings (last N)
   */
  getRecentMeetings(count: number = 10): MeetingRecord[] {
    return this.getAllMeetings().slice(0, count);
  }

  /**
   * Search meetings by text
   */
  searchMeetings(query: string): MeetingRecord[] {
    const lowerQuery = query.toLowerCase();

    return this.getAllMeetings().filter(meeting => {
      const titleMatch = meeting.title.toLowerCase().includes(lowerQuery);
      const textMatch = meeting.transcript.fullText.toLowerCase().includes(lowerQuery);
      const tagsMatch = meeting.tags?.some(tag => tag.toLowerCase().includes(lowerQuery));

      return titleMatch || textMatch || tagsMatch;
    });
  }

  /**
   * Delete meeting
   */
  deleteMeeting(id: string): boolean {
    const meeting = this.meetings.get(id);
    if (!meeting) return false;

    // Delete audio file if exists
    if (meeting.audioPath && fs.existsSync(meeting.audioPath)) {
      fs.unlinkSync(meeting.audioPath);
    }

    // Delete transcript file
    const transcriptPath = path.join(this.meetingsDir, `${id}.json`);
    if (fs.existsSync(transcriptPath)) {
      fs.unlinkSync(transcriptPath);
    }

    // Remove from index
    this.meetings.delete(id);
    this.saveIndex();

    console.log(`[MeetingManager] Deleted meeting: ${meeting.title}`);

    return true;
  }

  /**
   * Update meeting title
   */
  updateTitle(id: string, newTitle: string): boolean {
    const meeting = this.meetings.get(id);
    if (!meeting) return false;

    meeting.title = newTitle;
    this.saveIndex();

    return true;
  }

  /**
   * Add tags to meeting
   */
  addTags(id: string, tags: string[]): boolean {
    const meeting = this.meetings.get(id);
    if (!meeting) return false;

    meeting.tags = [...(meeting.tags || []), ...tags];
    this.saveIndex();

    return true;
  }

  /**
   * Export meeting to markdown
   */
  exportToMarkdown(id: string, outputPath: string): boolean {
    const meeting = this.meetings.get(id);
    if (!meeting) return false;

    const markdown = this.formatAsMarkdown(meeting);
    fs.writeFileSync(outputPath, markdown, 'utf-8');

    console.log(`[MeetingManager] Exported to: ${outputPath}`);

    return true;
  }

  /**
   * Export meeting to plain text
   */
  exportToText(id: string, outputPath: string): boolean {
    const meeting = this.meetings.get(id);
    if (!meeting) return false;

    const text = this.formatAsText(meeting);
    fs.writeFileSync(outputPath, text, 'utf-8');

    console.log(`[MeetingManager] Exported to: ${outputPath}`);

    return true;
  }

  /**
   * Format meeting as markdown
   */
  private formatAsMarkdown(meeting: MeetingRecord): string {
    const date = new Date(meeting.timestamp);
    const dateStr = date.toLocaleString();

    let markdown = `# ${meeting.title}\n\n`;
    markdown += `**Date:** ${dateStr}\n`;
    markdown += `**Duration:** ${this.formatDuration(meeting.duration)}\n`;
    markdown += `**Model:** ${meeting.transcript.modelUsed}\n`;

    if (meeting.tags && meeting.tags.length > 0) {
      markdown += `**Tags:** ${meeting.tags.join(', ')}\n`;
    }

    markdown += `\n---\n\n`;

    if (meeting.summary) {
      markdown += `## Summary\n\n${meeting.summary}\n\n---\n\n`;
    }

    markdown += `## Transcript\n\n`;

    for (const segment of meeting.transcript.segments) {
      const timestamp = this.formatTimestamp(segment.startTime);
      markdown += `**[${timestamp}]** ${segment.text}\n\n`;
    }

    return markdown;
  }

  /**
   * Format meeting as plain text
   */
  private formatAsText(meeting: MeetingRecord): string {
    const date = new Date(meeting.timestamp);
    const dateStr = date.toLocaleString();

    let text = `${meeting.title}\n`;
    text += `${'='.repeat(meeting.title.length)}\n\n`;
    text += `Date: ${dateStr}\n`;
    text += `Duration: ${this.formatDuration(meeting.duration)}\n\n`;

    if (meeting.summary) {
      text += `Summary:\n${meeting.summary}\n\n`;
    }

    text += `Transcript:\n\n`;

    for (const segment of meeting.transcript.segments) {
      const timestamp = this.formatTimestamp(segment.startTime);
      text += `[${timestamp}] ${segment.text}\n\n`;
    }

    return text;
  }

  /**
   * Format timestamp (MM:SS or HH:MM:SS)
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
   * Format duration (human readable)
   */
  private formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }

  /**
   * Get storage statistics
   */
  getStorageStats(): {
    totalMeetings: number;
    totalDuration: number;
    totalSize: number;
  } {
    let totalDuration = 0;
    let totalSize = 0;

    for (const meeting of this.meetings.values()) {
      totalDuration += meeting.duration;

      if (meeting.audioPath && fs.existsSync(meeting.audioPath)) {
        totalSize += fs.statSync(meeting.audioPath).size;
      }
    }

    return {
      totalMeetings: this.meetings.size,
      totalDuration,
      totalSize
    };
  }
}
