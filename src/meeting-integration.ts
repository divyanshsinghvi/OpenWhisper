/**
 * meeting-integration.ts
 *
 * Integration code for meeting mode in main.ts
 * Add this to your main.ts file
 */

import { BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import { RecordingManager } from './recording';
import { MeetingTranscriber } from './MeetingTranscriber';
import { MeetingManager } from './MeetingManager';

let meetingWindow: BrowserWindow | null = null;
let meetingRecordingManager: RecordingManager | null = null;
let meetingTranscriber: MeetingTranscriber | null = null;
let meetingManager: MeetingManager | null = null;
let currentMeetingAudioPath: string | null = null;

/**
 * Create meeting mode window
 */
export function createMeetingWindow() {
  if (meetingWindow) {
    meetingWindow.focus();
    return;
  }

  meetingWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js') // You'll need to create this
    },
    frame: true,
    resizable: true,
    title: 'Meeting Mode - Listen',
    backgroundColor: '#667eea'
  });

  meetingWindow.loadFile(path.join(__dirname, '..', 'assets', 'meeting.html'));

  meetingWindow.on('closed', () => {
    meetingWindow = null;
  });

  // Initialize meeting components
  if (!meetingTranscriber) {
    meetingTranscriber = new MeetingTranscriber(30); // 30-second chunks
    meetingTranscriber.initialize();
  }

  if (!meetingManager) {
    meetingManager = new MeetingManager();
  }
}

/**
 * Setup IPC handlers for meeting mode
 */
export function setupMeetingIPC() {
  // Start meeting recording
  ipcMain.on('meeting:start', async () => {
    try {
      console.log('[Meeting] Starting recording...');

      if (!meetingRecordingManager) {
        meetingRecordingManager = new RecordingManager();
      }

      await meetingRecordingManager.startRecording();
      console.log('[Meeting] Recording started');

    } catch (error) {
      console.error('[Meeting] Error starting recording:', error);
      meetingWindow?.webContents.send('meeting:error', String(error));
    }
  });

  // Stop meeting recording and transcribe
  ipcMain.on('meeting:stop', async () => {
    try {
      console.log('[Meeting] Stopping recording...');

      if (!meetingRecordingManager) {
        throw new Error('No recording in progress');
      }

      // Stop recording
      currentMeetingAudioPath = await meetingRecordingManager.stopRecording();
      console.log(`[Meeting] Recording stopped: ${currentMeetingAudioPath}`);

      if (!meetingTranscriber) {
        meetingTranscriber = new MeetingTranscriber(30);
        await meetingTranscriber.initialize();
      }

      // Transcribe with progress updates
      console.log('[Meeting] Starting transcription...');

      const transcript = await meetingTranscriber.transcribeMeeting(
        currentMeetingAudioPath,
        (current, total, text, percent) => {
          // Send progress to UI
          meetingWindow?.webContents.send('meeting:progress', {
            current,
            total,
            percent,
            text
          });

          console.log(`[Meeting] Progress: ${percent}% (${current}/${total})`);
        }
      );

      console.log('[Meeting] Transcription complete');

      // Send complete transcript to UI
      meetingWindow?.webContents.send('meeting:complete', transcript);

      // Store in meeting manager
      if (meetingManager) {
        meetingManager.saveMeeting(
          transcript,
          undefined, // Will use default title
          currentMeetingAudioPath,
          false // Don't keep audio by default
        );
      }

    } catch (error) {
      console.error('[Meeting] Error during transcription:', error);
      meetingWindow?.webContents.send('meeting:error', String(error));
    }
  });

  // Save meeting
  ipcMain.on('meeting:save', async () => {
    try {
      // Show save dialog
      const result = await dialog.showSaveDialog({
        title: 'Save Meeting Transcript',
        defaultPath: `meeting_${new Date().toISOString().split('T')[0]}.md`,
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: 'Text', extensions: ['txt'] }
        ]
      });

      if (!result.canceled && result.filePath && meetingManager) {
        const meetings = meetingManager.getRecentMeetings(1);
        if (meetings.length > 0) {
          const ext = path.extname(result.filePath);
          if (ext === '.md') {
            meetingManager.exportToMarkdown(meetings[0].id, result.filePath);
          } else {
            meetingManager.exportToText(meetings[0].id, result.filePath);
          }
          console.log(`[Meeting] Saved to: ${result.filePath}`);
        }
      }
    } catch (error) {
      console.error('[Meeting] Error saving:', error);
    }
  });

  // Export meeting
  ipcMain.on('meeting:export', async () => {
    try {
      const result = await dialog.showSaveDialog({
        title: 'Export Meeting Transcript',
        defaultPath: `meeting_${new Date().toISOString().split('T')[0]}.md`,
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: 'Text', extensions: ['txt'] },
          { name: 'JSON', extensions: ['json'] }
        ]
      });

      if (!result.canceled && result.filePath && meetingManager) {
        const meetings = meetingManager.getRecentMeetings(1);
        if (meetings.length > 0) {
          const ext = path.extname(result.filePath);
          if (ext === '.md') {
            meetingManager.exportToMarkdown(meetings[0].id, result.filePath);
          } else if (ext === '.json') {
            const fs = require('fs');
            fs.writeFileSync(result.filePath, JSON.stringify(meetings[0], null, 2));
          } else {
            meetingManager.exportToText(meetings[0].id, result.filePath);
          }
          console.log(`[Meeting] Exported to: ${result.filePath}`);
        }
      }
    } catch (error) {
      console.error('[Meeting] Error exporting:', error);
    }
  });

  // Close meeting window
  ipcMain.on('meeting:close', () => {
    if (meetingWindow) {
      meetingWindow.close();
    }
  });
}

/**
 * Get meeting manager instance
 */
export function getMeetingManager(): MeetingManager | null {
  return meetingManager;
}
