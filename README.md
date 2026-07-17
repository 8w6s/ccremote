# ccRemote

ccRemote runs Claude Code on your own machine and lets you operate it from Discord. Each Discord channel maps to one Claude session: messages become prompts, files become inputs, and Claude's replies, tools, approvals, plans, and task state are rendered back into the channel.

The Claude JSONL transcript on disk remains the source of truth. Discord is a remote interface, not a replacement session format.

## What works

- Create, reopen, close, fork, branch, rename, sync, and delete sessions.
- Stream replies without sending a new message for every text fragment.
- Show tool calls as cards that move from running to their final state.
- Handle Bash and file-edit approvals, including diffs and permission suggestions.
- Render `AskUserQuestion` as Discord selects, buttons, and modals.
- Keep one live task dashboard per session.
- Import existing Claude Code JSONL sessions and resume from checkpoints.
- Accept text, source files, images, binary attachments, and Discord oversized pastes.
- Run steerable background sessions in a separate category.
- Keep stable channel sequence names such as `s-0000-0001`.

The full behavior and data model are documented in [DOCS.md](DOCS.md).

## Requirements

- Node.js 22 or newer
- Claude Code installed as `claude` and available in `PATH`
- Python 3.10 or newer for the interactive installer
- A Discord application with Message Content intent enabled
- A private Discord server where the bot can manage channels, threads, messages, and its own roles

Guild Members intent is also required for role and handoff features.

## Quick start

```bash
git clone https://github.com/8w6s/ccremote.git
cd ccremote
./setup.sh
```

On Windows, run:

```powershell
.\setup.ps1
```

The installer can write `.env`, configure a custom Claude-compatible API, install dependencies, run checks, register slash commands, and create a user-level startup service. It asks before performing each optional action. When autostart is enabled, setup copies a production-only runtime into the current user's application-data directory; the service does not depend on the cloned repository remaining in place.

Setup resolves the Claude Code executable to an absolute `CLAUDE_BIN` path before creating a daemon. This is necessary because systemd, LaunchAgent, and Task Scheduler do not necessarily inherit the PATH from an interactive terminal.

To try the interface without changing files or starting services:

```bash
python3 setup/demo.py
```

### Manual installation

```bash
npm ci
cp .env.example .env
# edit .env
npm run check
npm run deploy
npm run dev
```

For a production build:

```bash
npm run build
npm start
```

Run only one copy of the bot. If the installer created an autostart service, do not also leave `npm run dev` running. After a successful daemon installation the source checkout may be removed, although keeping it makes future updates easier.

## Discord setup

Create these first:

1. A hub text channel for the New Session control.
2. A category for active sessions.
3. A category for archived sessions, if you want `/close` to move channels.
4. A category for background sessions, if you want `/background`.

Put their IDs in `.env`. The required values are:

| Variable | Purpose |
|---|---|
| `BOT_TOKEN` | Discord bot token |
| `CLIENT_ID` | Discord application ID |
| `GUILD_ID` | The one server ccRemote is allowed to remain in |
| `OWNER_ID` | Discord user allowed to run owner-only commands |
| `HUB_CHANNEL_ID` | Channel containing the New Session control |
| `CATEGORY_ID` | Active session category |

Useful optional values:

| Variable | Purpose |
|---|---|
| `ARCHIVE_CATEGORY_ID` | Primary destination used by `/close`; overflow categories are created when full |
| `BACKGROUND_CATEGORY_ID` | Destination used by `/background` |
| `DEFAULT_CWD` | Starting directory for new sessions |
| `ALLOWED_CWD_PREFIXES` | Comma-separated roots accepted by `/cwd` and `/cd` |
| `MAX_PROMPTS_PER_HOUR` | Per-channel prompt limit; defaults to `60` |
| `MAX_ATTACHMENT_BYTES` | Maximum downloaded attachment size |
| `MAX_INLINE_TEXT_BYTES` | Maximum text attachment inlined into a prompt |

See [.env.example](.env.example) for every setting and its default.

ccRemote leaves any guild whose ID does not match `GUILD_ID`. This prevents an accidentally public invite from turning the host into a shared Claude runner.

## Using it

Press **New Session** in the hub or run `/new`. The bot creates a mapped session channel. Send ordinary messages and attachments there; Claude starts lazily on the first valid prompt.

`/close` first moves the channel into the archive and only then commits the closed state. If Discord's 50-channel category limit is reached, ccRemote creates `close session-overflow 0001`, `0002`, `0003`, and further categories automatically. Sending another message or running `/open` makes the session active again. `/delete` is the destructive operation and requires confirmation.

Common commands:

| Command | Action |
|---|---|
| `/new` | Create a session channel |
| `/status` | Show UUID, JSONL path, cwd, model, mode, effort, sync, and runner state |
| `/close`, `/open` | Archive or reopen the current session |
| `/branch`, `/fork` | Create a related conversation |
| `/sync-sessions` | Import unmapped local Claude sessions |
| `/mode`, `/model`, `/effort` | Change Claude runtime settings |
| `/task` | Show the current task list ephemerally |
| `/context` | Show context, skills, and free-space usage |
| `/background` | Start an independently steerable background session |
| `/stop` | Stop the current foreground or background run |
| `/login`, `/logout`, `/customapi` | Manage machine-wide Claude authentication; owner only |
| `/recap` | Generate or configure session recaps |

The complete command reference, including component states and failure handling, is in [DOCS.md](DOCS.md#16-commands).

## Files and attachments

Small text and source files are included directly in the prompt. Large text files and binary files are downloaded to a sanitized, collision-safe path below the operating system's temporary directory. Discord-generated `messages.txt` attachments are merged with the visible part of the message, so an oversized paste reaches Claude as one prompt.

Unicode emoji are kept. Discord custom emoji and stickers are ignored as control noise; a message containing nothing else does not start or resume Claude.

## Session storage

Claude's transcripts stay in Claude Code's normal project storage. ccRemote stores channel mappings, sequence numbers, sync checkpoints, team access, and notification preferences in its own state directory under `$XDG_STATE_HOME/clauderemote` or the platform fallback.

Channel names are labels only. The mapping is based on Discord channel ID and Claude session UUID, so renaming a channel does not break a session.

To resolve a channel outside Discord:

```bash
npm run cli -- resolve-channel <discord_channel_id>
```

The command prints machine-readable JSON and returns distinct exit codes for missing, stale, and invalid mappings.

## Custom API endpoints

`/customapi` is owner-only. It writes the endpoint, key, and model aliases into Claude Code's `settings.json`, with restrictive file permissions where the platform supports them. The values are also applied to subsequently spawned Claude processes.

`/context` also works with custom API endpoints. Claude Code reports the tokens currently occupying the model's actual context window; ccRemote parses that runtime output instead of querying the provider separately.

## Security notes

This bot can operate a coding agent with the permissions of its operating-system account. Keep it on a private server, use a dedicated host account or container where possible, restrict `ALLOWED_CWD_PREFIXES`, and keep the team list small. `bypassPermissions` removes important safeguards; do not use it on an untrusted host or repository.

Never commit `.env`, Claude settings containing API keys, or ccRemote's runtime state. Read [SECURITY.md](SECURITY.md) before exposing the bot beyond a personal test server.

## Development

```bash
npm run typecheck
npm run test:unit
npm run build
npm pack --dry-run
```

Run all local checks with:

```bash
npm run check
```

Live events and imported JSONL events pass through the same normalized event model and Discord renderer. If you add a new Claude event, implement it in that shared path rather than creating a Discord-only branch. More detail is in [DOCS.md](DOCS.md).

## License

MIT. Created and maintained by [8w6s](https://github.com/8w6s).
