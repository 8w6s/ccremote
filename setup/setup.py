#!/usr/bin/env python3
"""Cross-platform interactive installer for ccRemote (stdlib only)."""

from __future__ import annotations

import getpass
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / ".env"
CLAUDE_SETTINGS = Path.home() / ".claude" / "settings.json"


class C:
    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    CYAN = "\033[38;5;51m"
    PURPLE = "\033[38;5;141m"
    PINK = "\033[38;5;213m"
    GREEN = "\033[38;5;84m"
    YELLOW = "\033[38;5;220m"
    RED = "\033[38;5;203m"


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
        ("  ◉ ccRemote Setup", C.PINK + C.BOLD),
        ("  Discord control plane for Claude Code", C.PURPLE),
    ], C.PURPLE)
    print(color(f"  {step}\n", C.CYAN + C.BOLD))


def ask(label: str, default: str = "", secret: bool = False, required: bool = False) -> str:
    while True:
        suffix = f" {color(f'[{default}]', C.DIM)}" if default else ""
        prompt = f"  {color('›', C.PINK)} {label}{suffix}: "
        value = getpass.getpass(prompt) if secret else input(prompt)
        value = value.strip() or default
        if value or not required:
            return value
        print(color("    This value is required.", C.RED))


def yesno(label: str, default: bool = True) -> bool:
    hint = "Y/n" if default else "y/N"
    value = input(f"  {color('◆', C.CYAN)} {label} {color(f'[{hint}]', C.DIM)}: ").strip().lower()
    return default if not value else value in {"y", "yes"}


def run(command: list[str], *, check: bool = True) -> bool:
    print(color(f"  $ {' '.join(command)}", C.DIM))
    result = subprocess.run(command, cwd=ROOT, check=False)
    if check and result.returncode != 0:
        raise RuntimeError(f"Command failed with exit code {result.returncode}: {' '.join(command)}")
    return result.returncode == 0


def application_data_dir() -> Path:
    """Return a per-user, persistent application-data directory."""
    system = platform.system()
    if system == "Windows":
        return Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")) / "ccRemote"
    if system == "Darwin":
        return Path.home() / "Library" / "Application Support" / "ccRemote"
    return Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")) / "ccremote"


def find_claude_bin() -> Path:
    """Resolve Claude Code without relying on an interactive shell PATH."""
    names = ("claude.exe", "claude.cmd", "claude") if platform.system() == "Windows" else ("claude",)
    discovered = shutil.which("claude")
    candidates = [Path(discovered)] if discovered else []
    roots = [
        Path.home() / ".local" / "bin",
        Path.home() / ".npm-global" / "bin",
        Path.home() / ".claude" / "local",
        Path(os.environ.get("APPDATA", "")) / "npm" if os.environ.get("APPDATA") else None,
    ]
    candidates.extend(root / name for root in roots if root for name in names)
    for candidate in candidates:
        if candidate.is_file() and (platform.system() == "Windows" or os.access(candidate, os.X_OK)):
            return candidate.resolve()
    raise RuntimeError("Claude Code CLI was not found. Install it, then run setup again.")


def stage_runtime() -> Path:
    """Install a self-contained production runtime outside the source checkout."""
    if not (ROOT / "dist" / "index.js").exists():
        raise RuntimeError("Production build is missing. Run the validation/build step first.")
    data_dir = application_data_dir()
    app_dir = data_dir / "app"
    staging = data_dir / "app.new"
    previous = data_dir / "app.previous"
    data_dir.mkdir(parents=True, exist_ok=True)
    for disposable in (staging, previous):
        if disposable.exists():
            shutil.rmtree(disposable)
    staging.mkdir(parents=True)
    shutil.copytree(ROOT / "dist", staging / "dist")
    for name in ("package.json", "package-lock.json"):
        shutil.copy2(ROOT / name, staging / name)
    claude_bin = find_claude_bin()
    env_lines = [
        line for line in ENV_FILE.read_text(encoding="utf-8-sig").splitlines()
        if not line.startswith("CLAUDE_BIN=")
    ]
    env_lines.append(f"CLAUDE_BIN={claude_bin}")
    (staging / ".env").write_text("\n".join(env_lines) + "\n", encoding="utf-8")
    try:
        (staging / ".env").chmod(0o600)
    except OSError:
        pass

    npm = shutil.which("npm")
    if not npm:
        raise RuntimeError("npm is required to install production dependencies.")
    result = subprocess.run(
        [npm, "ci", "--omit=dev", "--no-audit", "--no-fund"],
        cwd=staging,
        check=False,
    )
    if result.returncode != 0:
        shutil.rmtree(staging, ignore_errors=True)
        raise RuntimeError(f"Production dependency installation failed with exit code {result.returncode}.")

    try:
        if app_dir.exists():
            app_dir.replace(previous)
        staging.replace(app_dir)
        shutil.rmtree(previous, ignore_errors=True)
    except Exception:
        if not app_dir.exists() and previous.exists():
            previous.replace(app_dir)
        raise
    return app_dir


def read_env() -> dict[str, str]:
    values: dict[str, str] = {}
    if not ENV_FILE.exists():
        return values
    for line in ENV_FILE.read_text(encoding="utf-8-sig").splitlines():
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def write_env(values: dict[str, str]) -> None:
    order = [
        "BOT_TOKEN", "CLIENT_ID", "GUILD_ID", "OWNER_ID", "HUB_CHANNEL_ID",
        "CATEGORY_ID", "ARCHIVE_CATEGORY_ID", "BACKGROUND_CATEGORY_ID",
        "DEFAULT_CWD", "ALLOWED_CWD_PREFIXES", "MAX_PROMPTS_PER_HOUR",
        "MAX_ATTACHMENT_BYTES", "MAX_IMAGE_BYTES", "MAX_INLINE_IMAGES",
        "MAX_INLINE_TEXT_BYTES", "ATTACHMENT_DOWNLOAD_TIMEOUT_MS",
    ]
    lines = ["# Generated by ccRemote setup. Keep this file private."]
    lines.extend(f"{key}={values.get(key, '')}" for key in order)
    tmp = ENV_FILE.with_suffix(".tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    try:
        tmp.chmod(0o600)
    except OSError:
        pass
    tmp.replace(ENV_FILE)


def configure_claude_gateway() -> None:
    base = ask("Anthropic-compatible base URL", required=True)
    key = ask("API key", secret=True, required=True)
    opus = ask("Opus model ID", required=True)
    sonnet = ask("Sonnet model ID", required=True)
    haiku = ask("Haiku model ID", required=True)
    settings: dict = {}
    if CLAUDE_SETTINGS.exists():
        settings = json.loads(CLAUDE_SETTINGS.read_text(encoding="utf-8"))
        backup = CLAUDE_SETTINGS.with_name("settings.json.ccremote.bak")
        shutil.copy2(CLAUDE_SETTINGS, backup)
    env = dict(settings.get("env") or {})
    env.update({
        "ANTHROPIC_BASE_URL": base.rstrip("/"),
        "ANTHROPIC_API_KEY": key,
        "ANTHROPIC_DEFAULT_OPUS_MODEL": opus,
        "ANTHROPIC_DEFAULT_SONNET_MODEL": sonnet,
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": haiku,
        "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    })
    settings["env"] = env
    CLAUDE_SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    tmp = CLAUDE_SETTINGS.with_suffix(".tmp")
    tmp.write_text(json.dumps(settings, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    try:
        tmp.chmod(0o600)
    except OSError:
        pass
    tmp.replace(CLAUDE_SETTINGS)


def install_autostart(start_now: bool) -> str:
    system = platform.system()
    node = shutil.which("node") or "node"
    app_dir = stage_runtime()
    data_dir = application_data_dir()
    log_dir = data_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    if system == "Linux":
        service_dir = Path.home() / ".config" / "systemd" / "user"
        service_dir.mkdir(parents=True, exist_ok=True)
        service = service_dir / "ccremote.service"
        service.write_text(
            "[Unit]\nDescription=ccRemote Discord control plane\nAfter=network-online.target\n\n"
            "[Service]\nType=simple\n"
            f"WorkingDirectory={app_dir}\nExecStart={node} {app_dir / 'dist' / 'index.js'}\n"
            "Restart=on-failure\nRestartSec=5\nEnvironment=NODE_ENV=production\n"
            f"StandardOutput=append:{log_dir / 'service.log'}\n"
            f"StandardError=append:{log_dir / 'service.log'}\n\n"
            "[Install]\nWantedBy=default.target\n",
            encoding="utf-8",
        )
        run(["systemctl", "--user", "daemon-reload"])
        run(["systemctl", "--user", "enable", "ccremote.service"])
        subprocess.run(
            ["systemctl", "--user", "disable", "--now", "clauderemote.service"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if start_now:
            run(["systemctl", "--user", "restart", "ccremote.service"])
        return str(service)
    if system == "Darwin":
        agents = Path.home() / "Library" / "LaunchAgents"
        agents.mkdir(parents=True, exist_ok=True)
        plist = agents / "dev.ccremote.bot.plist"
        plist.write_text(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
            "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" "
            "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n"
            "<plist version=\"1.0\"><dict>"
            "<key>Label</key><string>dev.ccremote.bot</string>"
            f"<key>ProgramArguments</key><array><string>{node}</string><string>{app_dir / 'dist' / 'index.js'}</string></array>"
            f"<key>WorkingDirectory</key><string>{app_dir}</string>"
            "<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>"
            f"<key>StandardOutPath</key><string>{log_dir / 'service.log'}</string>"
            f"<key>StandardErrorPath</key><string>{log_dir / 'service-error.log'}</string>"
            "</dict></plist>\n",
            encoding="utf-8",
        )
        if start_now:
            subprocess.run(["launchctl", "unload", str(plist)], check=False)
            run(["launchctl", "load", str(plist)])
        return str(plist)
    if system == "Windows":
        command = f'"{node}" "{app_dir / "dist" / "index.js"}"'
        args = ["schtasks", "/Create", "/F", "/SC", "ONLOGON", "/TN", "ccRemote", "/TR", command]
        run(args)
        if start_now:
            run(["schtasks", "/Run", "/TN", "ccRemote"])
        return "Windows Task Scheduler: ccRemote"
    raise RuntimeError(f"Automatic startup is not supported on {system}.")


def main() -> int:
    banner("1 / 6  Environment check")
    missing = [name for name in ("node", "npm") if not shutil.which(name)]
    if missing:
        print(color(f"  Missing required programs: {', '.join(missing)}", C.RED))
        return 1
    print(color(f"  ✓ Python {platform.python_version()}", C.GREEN))
    print(color(f"  ✓ Node {subprocess.check_output(['node', '--version'], text=True).strip()}", C.GREEN))
    try:
        print(color(f"  ✓ Claude Code {find_claude_bin()}", C.GREEN))
    except RuntimeError as error:
        print(color(f"  {error}", C.RED))
        return 1
    print(color(f"  ✓ Project {ROOT}", C.GREEN))
    input(color("\n  Press Enter to continue…", C.DIM))

    old = read_env()
    banner("2 / 6  Discord connection")
    values = dict(old)
    values["BOT_TOKEN"] = ask("Discord bot token", old.get("BOT_TOKEN", ""), secret=True, required=True)
    values["CLIENT_ID"] = ask("Discord application/client ID", old.get("CLIENT_ID", ""), required=True)
    values["GUILD_ID"] = ask("Authorized guild ID", old.get("GUILD_ID", ""), required=True)
    values["OWNER_ID"] = ask("Owner user ID", old.get("OWNER_ID", ""), required=True)
    values["HUB_CHANNEL_ID"] = ask("Hub channel ID", old.get("HUB_CHANNEL_ID", ""), required=True)

    banner("3 / 6  Channel layout")
    values["CATEGORY_ID"] = ask("Active session category ID", old.get("CATEGORY_ID", ""), required=True)
    values["ARCHIVE_CATEGORY_ID"] = ask("Archive category ID", old.get("ARCHIVE_CATEGORY_ID", ""))
    values["BACKGROUND_CATEGORY_ID"] = ask("Background-agent category ID", old.get("BACKGROUND_CATEGORY_ID", ""))

    banner("4 / 6  Runtime policy")
    values["DEFAULT_CWD"] = ask(
        "Default project directory",
        old.get("DEFAULT_CWD") or str(Path.home() / "PROJECTS"),
        required=True,
    )
    values["ALLOWED_CWD_PREFIXES"] = ask(
        "Allowed directories (comma-separated)",
        old.get("ALLOWED_CWD_PREFIXES") or values["DEFAULT_CWD"],
        required=True,
    )
    values["MAX_PROMPTS_PER_HOUR"] = ask("Maximum prompts per channel/hour", old.get("MAX_PROMPTS_PER_HOUR", "60"), required=True)
    for key, default in {
        "MAX_ATTACHMENT_BYTES": "26214400", "MAX_IMAGE_BYTES": "5242880",
        "MAX_INLINE_IMAGES": "5", "MAX_INLINE_TEXT_BYTES": "262144",
        "ATTACHMENT_DOWNLOAD_TIMEOUT_MS": "30000",
    }.items():
        values[key] = old.get(key, default)
    write_env(values)
    print(color("\n  ✓ Wrote private .env", C.GREEN))
    if yesno("Configure a custom Claude API gateway in settings.json?", False):
        configure_claude_gateway()
        print(color("  ✓ Merged Claude settings.json", C.GREEN))

    banner("5 / 6  Install and build")
    if yesno("Install/update npm dependencies?", True):
        run(["npm", "install"])
    if yesno("Run typecheck, tests, and production build?", True):
        run(["npm", "run", "check"])
    if yesno("Register guild slash commands now?", True):
        run(["npm", "run", "deploy"])

    banner("6 / 6  Automatic startup")
    daemon = "not requested"
    if yesno("Create an auto-start daemon for this user?", True):
        start_now = yesno("Start/restart ccRemote immediately after setup?", False)
        daemon = install_autostart(start_now)

    print()
    frame([
        ("  Setup complete", C.GREEN + C.BOLD),
        ("  Configuration and validation finished.", C.GREEN),
    ], C.GREEN, width=50)
    print(f"  Project : {ROOT}")
    print(f"  Config  : {ENV_FILE}")
    print(f"  Daemon  : {daemon}")
    print(color("\n  Run `npm run dev` for a foreground test.\n", C.DIM))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print(color("\n\n  Setup cancelled; no daemon changes were made after cancellation.\n", C.YELLOW))
        raise SystemExit(130)
    except Exception as exc:
        print(color(f"\n  Setup failed: {exc}\n", C.RED))
        raise SystemExit(1)
