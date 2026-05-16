#!/usr/bin/env python3
"""
Window focus management helper for WSL
Uses ctypes to directly call Windows APIs
"""
import sys
import json
import ctypes
from ctypes import wintypes

# Windows API functions
try:
    user32 = ctypes.windll.user32

    # GetForegroundWindow
    GetForegroundWindow = user32.GetForegroundWindow
    GetForegroundWindow.restype = wintypes.HWND
    GetForegroundWindow.argtypes = []

    # GetWindowTextW
    GetWindowTextW = user32.GetWindowTextW
    GetWindowTextW.restype = wintypes.INT
    GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, wintypes.INT]

    # SetForegroundWindow
    SetForegroundWindow = user32.SetForegroundWindow
    SetForegroundWindow.restype = wintypes.BOOL
    SetForegroundWindow.argtypes = [wintypes.HWND]

    WINDOWS_API_AVAILABLE = True
except Exception as e:
    print(f"Warning: Windows API not available: {e}", file=sys.stderr)
    WINDOWS_API_AVAILABLE = False


def get_foreground_window():
    """Get the currently focused window handle and title"""
    if not WINDOWS_API_AVAILABLE:
        return None

    try:
        hwnd = GetForegroundWindow()
        if not hwnd:
            return None

        # Get window title
        title_buffer = ctypes.create_unicode_buffer(256)
        GetWindowTextW(hwnd, title_buffer, 256)
        title = title_buffer.value

        return {
            'title': title,
            'handle': int(hwnd)
        }
    except Exception as e:
        print(f"Error in get_foreground_window: {e}", file=sys.stderr)
        return None


def restore_focus(window_info):
    """Restore focus to a window by handle"""
    if not WINDOWS_API_AVAILABLE:
        return False

    if not window_info or not window_info.get('handle'):
        return False

    try:
        hwnd = wintypes.HWND(window_info['handle'])
        result = SetForegroundWindow(hwnd)
        return bool(result)
    except Exception as e:
        print(f"Error in restore_focus: {e}", file=sys.stderr)
        return False


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: window_focus.py [get|restore] [json_data]")
        sys.exit(1)

    command = sys.argv[1]

    if command == 'get':
        window_info = get_foreground_window()
        print(json.dumps(window_info or {}))
    elif command == 'restore':
        try:
            window_info = json.loads(sys.argv[2]) if len(sys.argv) > 2 else None
            success = restore_focus(window_info)
            print(json.dumps({'success': success}))
        except Exception as e:
            print(json.dumps({'success': False, 'error': str(e)}))
