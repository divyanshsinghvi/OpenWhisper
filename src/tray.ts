/**
 * tray.ts
 *
 * macOS menu-bar (and Linux/Windows tray) entry for Listen.
 * Owns no app state — receives callbacks from main.ts so the same toggle/quit
 * paths are used everywhere.
 */

import { app, Tray, Menu, nativeImage } from 'electron';

export interface TrayCallbacks {
  toggleRecording: () => void;
  openSettings: () => void;
}

export class TrayManager {
  private tray: Tray | null = null;
  private callbacks: TrayCallbacks;
  private recording = false;

  constructor(callbacks: TrayCallbacks) {
    this.callbacks = callbacks;
  }

  create(): void {
    // No icon asset bundled — use an empty image and a text label.
    // On macOS this renders cleanly in the menu bar; on other platforms it
    // still surfaces a clickable tray entry with the context menu.
    const icon = nativeImage.createEmpty();
    this.tray = new Tray(icon);

    if (process.platform === 'darwin') {
      this.tray.setTitle(this.titleForState());
    }
    this.tray.setToolTip('Listen — voice dictation');

    this.tray.on('click', () => this.callbacks.toggleRecording());
    this.refresh();
  }

  setRecording(recording: boolean): void {
    this.recording = recording;
    if (this.tray && process.platform === 'darwin') {
      this.tray.setTitle(this.titleForState());
    }
    this.refresh();
  }

  destroy(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }

  private titleForState(): string {
    return this.recording ? '● rec' : '🎙';
  }

  private refresh(): void {
    if (!this.tray) return;
    const menu = Menu.buildFromTemplate([
      {
        label: this.recording ? 'Stop dictation' : 'Start dictation',
        accelerator: 'CommandOrControl+Shift+Space',
        click: () => this.callbacks.toggleRecording(),
      },
      { type: 'separator' },
      { label: 'Settings…', click: () => this.callbacks.openSettings() },
      { type: 'separator' },
      {
        label: 'About Listen',
        click: () =>
          app.showAboutPanel
            ? app.showAboutPanel()
            : void 0,
      },
      { label: 'Quit Listen', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
    ]);
    this.tray.setContextMenu(menu);
  }
}
