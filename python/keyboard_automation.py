#!/usr/bin/env python3
"""
Keyboard automation helper for Linux/Windows.

pyautogui is the preferred backend, but on Linux its MouseInfo import can
require system tkinter packages. Fall back to pynput so users without sudo can
still type/paste from a virtualenv.
"""
import json
import sys


def try_pyautogui(action: dict) -> bool:
    try:
        import pyautogui  # type: ignore
    except Exception:
        return False

    if action["type"] == "hotkey":
        pyautogui.hotkey(*action["keys"])
        return True

    if action["type"] == "type_change":
        for _ in range(action.get("deletes", 0)):
            pyautogui.press("backspace")
        text = action.get("text", "")
        if text:
            pyautogui.write(text)
        return True

    raise ValueError(f"Unknown action type: {action['type']}")


def pynput_key(name: str):
    from pynput.keyboard import Key

    mapping = {
        "enter": Key.enter,
        "tab": Key.tab,
        "space": Key.space,
        "esc": Key.esc,
        "left": Key.left,
        "right": Key.right,
        "down": Key.down,
        "up": Key.up,
        "backspace": Key.backspace,
        "ctrl": Key.ctrl,
        "alt": Key.alt,
        "shift": Key.shift,
        "command": Key.cmd,
    }
    return mapping.get(name, name)


def run_pynput(action: dict) -> None:
    try:
        from pynput.keyboard import Controller
    except Exception as error:
        raise RuntimeError(
            "Keyboard automation requires either pyautogui with tkinter "
            "(sudo apt-get install python3-tk python3-dev) or the user-space "
            "fallback package (pip install pynput)."
        ) from error

    keyboard = Controller()

    if action["type"] == "hotkey":
        keys = [pynput_key(key) for key in action["keys"]]
        for key in keys:
            keyboard.press(key)
        for key in reversed(keys):
            keyboard.release(key)
        return

    if action["type"] == "type_change":
        for _ in range(action.get("deletes", 0)):
            keyboard.press(pynput_key("backspace"))
            keyboard.release(pynput_key("backspace"))
        text = action.get("text", "")
        if text:
            keyboard.type(text)
        return

    raise ValueError(f"Unknown action type: {action['type']}")


def main() -> None:
    action = json.loads(sys.stdin.read())
    if not try_pyautogui(action):
        run_pynput(action)


if __name__ == "__main__":
    main()
