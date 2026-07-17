#!/usr/bin/env python3
"""Safe interactive preview of the ccRemote setup TUI. Makes no changes."""

from __future__ import annotations

import getpass
import platform
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class C:
    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    CYAN = "\033[38;5;51m"
    PURPLE = "\033[38;5;141m"
    PINK = "\033[38;5;213m"
    GREEN = "\033[38;5;84m"
    YELLOW = "\033[38;5;220m"


def color(text: str, code: str) -> str:
    return f"{code}{text}{C.RESET}" if sys.stdout.isatty() else text


ANSI_ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def display_width(text: str) -> int:
    """Return terminal columns used by text, excluding ANSI escapes."""
    plain = ANSI_ESCAPE.sub("", text)
    return sum(
        0 if unicodedata.combining(char)
        else 2 if unicodedata.east_asian_width(char) in {"W", "F"}
        else 1
        for char in plain
    )


def pad_to_width(text: str, width: int) -> str:
    return text + " " * max(0, width - display_width(text))


def frame(lines: list[tuple[str, str]], border: str, width: int = 64) -> None:
    """Draw a fixed-width frame without ANSI or Unicode alignment drift."""
    inner = width - 2
    print(color(f"╭{'─' * inner}╮", border))
    for text, style in lines:
        print(color("│", border) + color(pad_to_width(text, inner), style) + color("│", border))
    print(color(f"╰{'─' * inner}╯", border))


def clear() -> None:
    if sys.stdout.isatty():
        print("\033[2J\033[H", end="")


def banner(step: str) -> None:
    clear()
    frame([
        ("  ◉ ccRemote Setup · SAFE DEMO", C.PINK + C.BOLD),
        ("  Preview only — filesystem, Discord and services untouched", C.PURPLE),
    ], C.PURPLE)
    print(color(f"  {step}\n", C.CYAN + C.BOLD))


def ask(label: str, default: str = "", secret: bool = False) -> str:
    suffix = f" {color(f'[{default}]', C.DIM)}" if default else ""
    prompt = f"  {color('›', C.PINK)} {label}{suffix}: "
    value = getpass.getpass(prompt) if secret else input(prompt)
    return value.strip() or default


def yesno(label: str, default: bool = True) -> bool:
    hint = "Y/n" if default else "y/N"
    value = input(f"  {color('◆', C.CYAN)} {label} {color(f'[{hint}]', C.DIM)}: ").strip().lower()
    return default if not value else value in {"y", "yes"}


def pause() -> None:
    input(color("\n  Press Enter to continue…", C.DIM))


def main() -> int:
    answers: dict[str, str | bool] = {}

    banner("1 / 6  Environment check")
    print(color(f"  ✓ Python {platform.python_version()}", C.GREEN))
    print(color("  ✓ Node v22.x (simulated)", C.GREEN))
    print(color(f"  ✓ Project {ROOT}", C.GREEN))
    print(color("\n  DEMO: no prerequisite commands are executed.", C.YELLOW))
    pause()

    banner("2 / 6  Discord connection")
    answers["token"] = ask("Discord bot token", "demo-token-hidden", secret=True)
    answers["client"] = ask("Discord application/client ID", "123456789012345678")
    answers["guild"] = ask("Authorized guild ID", "123456789012345678")
    answers["owner"] = ask("Owner user ID", "123456789012345678")
    answers["hub"] = ask("Hub channel ID", "123456789012345678")

    banner("3 / 6  Channel layout")
    answers["active"] = ask("Active session category ID", "111111111111111111")
    answers["archive"] = ask("Archive category ID", "222222222222222222")
    answers["background"] = ask("Background-agent category ID", "333333333333333333")

    banner("4 / 6  Runtime policy")
    answers["cwd"] = ask("Default project directory", str(Path.home() / "PROJECTS"))
    answers["allowed"] = ask("Allowed directories (comma-separated)", str(Path.home() / "PROJECTS"))
    answers["rate"] = ask("Maximum prompts per channel/hour", "60")
    answers["gateway"] = yesno("Configure a custom Claude API gateway in settings.json?", False)
    if answers["gateway"]:
        answers["base_url"] = ask("Anthropic-compatible base URL", "https://gateway.example.com")
        answers["api_key"] = ask("API key", "demo-key-hidden", secret=True)
        answers["opus"] = ask("Opus model ID", "provider-opus")
        answers["sonnet"] = ask("Sonnet model ID", "provider-sonnet")
        answers["haiku"] = ask("Haiku model ID", "provider-haiku")
    print(color("\n  DEMO: .env and ~/.claude/settings.json were not written.", C.YELLOW))
    pause()

    banner("5 / 6  Install and build")
    answers["install"] = yesno("Install/update npm dependencies?", True)
    answers["check"] = yesno("Run typecheck, tests, and production build?", True)
    answers["deploy"] = yesno("Register guild slash commands now?", True)
    print(color("\n  DEMO command preview:", C.YELLOW + C.BOLD))
    if answers["install"]:
        print(color("    $ npm install       (not executed)", C.DIM))
    if answers["check"]:
        print(color("    $ npm run check     (not executed)", C.DIM))
    if answers["deploy"]:
        print(color("    $ npm run deploy    (not executed)", C.DIM))
    pause()

    banner("6 / 6  Automatic startup")
    answers["daemon"] = yesno("Create an auto-start daemon for this user?", True)
    answers["start"] = (
        yesno("Start/restart ccRemote immediately after setup?", False)
        if answers["daemon"] else False
    )
    daemon_kind = {
        "Linux": "user systemd service",
        "Darwin": "LaunchAgent",
        "Windows": "Task Scheduler entry",
    }.get(platform.system(), "platform service")

    print()
    frame([
        ("  Demo complete", C.GREEN + C.BOLD),
        ("  ✓ No files, credentials or services changed", C.GREEN + C.BOLD),
    ], C.GREEN, width=50)
    print(f"  Would configure : guild {answers['guild']}")
    print(f"  Would use CWD   : {answers['cwd']}")
    print(f"  Would deploy    : {'yes' if answers['deploy'] else 'no'}")
    print(f"  Would install   : {daemon_kind if answers['daemon'] else 'no daemon'}")
    print(f"  Would start now : {'yes' if answers['start'] else 'no'}")
    print(color("\n  Run ./setup.sh (or .\\setup.ps1) only when ready for real setup.\n", C.DIM))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print(color("\n\n  Demo cancelled. No changes were made.\n", C.YELLOW))
        raise SystemExit(130)
