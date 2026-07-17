# clauderemote

Control the real Claude Code CLI on your workstation or VPS from Discord.

clauderemote is a self-hosted control plane, not a Claude reimplementation. A Discord channel represents a Claude Code session; messages become prompts; assistant output, tool calls, permissions, questions, plans, tasks, and status are rendered back into Discord. Claude's local JSONL transcript remains the authoritative conversation record.

> Read [DOCS.md](DOCS.md) for the complete product specification, every command and component interaction, state model, synchronization protocol, security boundary, and recovery behavior.

## Highlights

- One Discord channel per Claude session UUID.
- Shared event pipeline for live Claude output and JSONL transcript replay.
- Streaming assistant responses with edit throttling and duplicate guards.
- Tool cards that update from running to success, failure, denial, or cancellation.
- Discord approval UI for Bash, generic tools, Edit/Write diffs, and ExitPlanMode.
- Full AskUserQuestion flow: single-select, multi-select, descriptions, custom answers, partial submission, navigation, and pagination beyond 25 options.
- One real-time task dashboard per channel plus ephemeral `/task` views.
- Stable session names such as `s-0000-0001`, independent from timestamps and UUIDs.
- Import and mirror local Claude JSONL sessions with progress and resumable byte checkpoints.
- Attachment normalization for oversized Discord pastes, text/code, images, and binary files.
- Owner/team authorization, cwd allowlist, secret scrubbing, process singleton, and mapping reconciliation.
- Deterministic `resolve-channel` CLI for automation.

## Architecture

```text
Discord input
   │
   ▼
authorization + input normalization
   │
   ▼
channel/session mapping ─── Runner ─── local `claude` CLI
                               │              │
                               │ live events  │ JSONL
                               ▼              ▼
                         canonical event model
                                  │
                                  ▼
                         shared Discord renderer
```

Identity rules:

- Claude session UUID is the authoritative conversation identity.
- Discord channel ID is the authoritative frontend identity.
- JSONL path is stored explicitly.
- Channel names are display labels only.
- Discord snowflakes are never transformed into Claude UUIDs.

## Requirements

- Node.js 22 or newer.
- Claude Code installed and available as `claude` in `PATH`.
- A Discord application and bot token.
- One Discord guild with:
  - an active-session category;
  - a hub text channel;
  - optionally an archive category.
- Discord bot permissions to view/send/manage messages, create/manage channels and threads, and manage the bot's effort roles.
- Message Content intent enabled. Guild Members intent is needed for member/role and handoff features.

## Installation

```bash
git clone https://github.com/8w6s/clauderemote.git
cd clauderemote
npm ci
cp .env.example .env
```

Fill in `.env`, then register guild commands once:

```bash
npm run deploy
```

Development foreground process:

```bash
npm run dev
```

Production build:

```bash
npm run build
npm start
```

Use exactly one process manager. Do not run systemd and a manual/nohup copy at the same time. A PID lock is additional protection, not a substitute for correct service management.

## Configuration

Required:

| Variable | Meaning |
|---|---|
| `BOT_TOKEN` | Discord bot token |
| `CLIENT_ID` | Discord application ID |
| `GUILD_ID` | The only authorized guild |
| `OWNER_ID` | Bot owner Discord user ID |
| `HUB_CHANNEL_ID` | Channel containing the New Session control |
| `CATEGORY_ID` | Active session category |

Optional:

| Variable | Default | Meaning |
|---|---|---|
| `ARCHIVE_CATEGORY_ID` | empty | Category used by `/close` |
| `ANTHROPIC_BASE_URL` | Claude default | Custom Claude/Anthropic-compatible endpoint |
| `ANTHROPIC_AUTH_TOKEN` | Claude default | Custom endpoint credential |
| `DEFAULT_CWD` | `<home>/PROJECTS` | Initial working directory |
| `ALLOWED_CWD_PREFIXES` | project root and OS temp | Comma-separated canonical cwd roots |
| `MAX_PROMPTS_PER_HOUR` | `60` | Per-channel in-memory prompt limit |
| `MAX_ATTACHMENT_BYTES` | `26214400` | Maximum downloaded attachment size |
| `MAX_IMAGE_BYTES` | `5242880` | Maximum inline image size |
| `MAX_INLINE_IMAGES` | `5` | Maximum inline images per prompt |
| `MAX_INLINE_TEXT_BYTES` | `262144` | Maximum text attachment inlined into a prompt |
| `ATTACHMENT_DOWNLOAD_TIMEOUT_MS` | `30000` | Attachment download timeout |

Never commit `.env`. Local state is stored below `$XDG_STATE_HOME/clauderemote` or the platform home-state fallback. Claude transcripts remain under Claude Code's own project storage.

## Session workflow

1. Press **New Session** or run `/new`.
2. The bot allocates a stable sequence and creates `🟣-s-NNNN-NNNN`.
3. Send a message or attachment in the channel.
4. The bot normalizes input and lazily starts Claude.
5. Output streams back; tool messages update in place.
6. Permission requests become correlated buttons/selects/modals.
7. Use `/close` to archive without deleting JSONL.
8. Send another message or use `/open` to reopen.
9. Use `/delete confirm:true` only for permanent removal.

Typing starts only for accepted prompts. A successful live turn mentions its requester once; cancelled, ignored, duplicated, or historical sync events do not.

## Input and attachments

- Unicode emoji remains ordinary prompt text.
- Discord custom emoji tokens are stripped.
- Sticker-only and custom-emoji-only messages are ignored without waking Claude.
- Visible message content is retained when files are attached.
- Small UTF-8 text/code files are inlined with filename boundaries.
- Discord oversized `messages.txt` pastes are merged with visible text.
- Large text and binary files are stored under the operating system temp directory:

```text
<temp>/clauderemote/<session-or-channel>/<message>/<safe unique filename>
```

- Names are sanitized, downloads are size/time bounded, and files are never executed automatically.
- Eligible files are cleaned on close/delete and by lifecycle cleanup.

## Permission modes

Use `/mode`:

| Mode | Behavior |
|---|---|
| `bypassPermissions` | Passes Claude's dangerous skip-permissions flag |
| `auto` | Runtime decides which actions require confirmation |
| `manual` | Forces interactive permission handling where supported |
| `acceptEdits` | Eligible edits are accepted; other tools may prompt |
| `plan` | Planning/read-only workflow with dedicated plan approval |

Approve Once does not persist permission suggestions. Always Allow is shown only when Claude supplies real `permission_suggestions`, which are returned through the documented permission result.

## Effort

Use `/effort` to set per-session reasoning effort. The visual role belongs to the bot member, never the human user:

- low — yellow
- medium — green
- high — cyan
- xhigh — light purple
- max — red
- ultracode — deep purple
- auto — model default, no explicit effort role

Changing mode/effort/model during a turn is deferred until the turn finishes where interruption would corrupt the active workflow.

## Commands

| Command | Purpose |
|---|---|
| `/new` | Create a mapped session channel |
| `/close` | Stop and archive without deleting history |
| `/open` | Reopen a closed session |
| `/delete` | Permanently remove the exact mapped session |
| `/rename` | Change display name without changing identity |
| `/branch` | Replay/fork into a new channel |
| `/fork` | Fork Claude identity in the current channel |
| `/sync-sessions` | Import all unmapped local JSONL sessions |
| `/status` | Show session identity, sync, Runner, JSONL and mapping health |
| `/cwd` | Change to a canonical allowed working directory |
| `/model` | Set the session model |
| `/mode` | Set permission mode |
| `/effort` | Set effort and bot effort role |
| `/clear` | Clear active context while preserving transcript |
| `/compact` | Request native context compaction |
| `/context` | Request detailed context information on official Anthropic API |
| `/usage` | Request Claude usage/cost information |
| `/btw` | Send a visually distinct quick aside |
| `/stop` | Abort the active turn |
| `/rewind` | Browse historical user prompts ephemerally |
| `/task` | Show the session task list ephemerally |
| `/goal` | Manage persistent bot-side objective metadata |
| `/loop` | Start/status/stop recurring prompt intent |
| `/skill` | Invoke a local Claude skill |
| `/reload-skills` | Reload skills on the next Runner |
| `/diff`, `/doctor`, `/init`, `/recap` | Forward native Claude Code commands |
| `/git` | Run a constrained native Git utility without a Claude turn |
| `/team` | Owner-only team allowlist management |
| `/handoff` | Grant an authorized user channel access |
| `/notify` | Toggle long-turn completion notifications |
| `/ping` | Test bot interaction health |
| `/claude-help` | Show the Discord/Claude feature map |

Every option, state transition, interaction and failure mode is documented in [DOCS.md](DOCS.md#16-commands).

## Local transcript synchronization

`/sync-sessions` discovers Claude JSONL files on the machine. Initial ordering uses the first valid transcript timestamp, then filesystem birth/modified time, UUID, and path. Existing sequences never change.

Import progress shows events, percentage and ETA. Byte checkpoints are stored at complete JSONL record boundaries. After initial import, the mirror catches up from its durable offset and tails new complete records. Tool results correlate to tool cards by the real tool-use ID.

Unknown/internal/thinking records are not rendered. Unknown public records are logged defensively rather than crashing the mirror.

## Resolver CLI

After a build or global package installation:

```bash
clauderemote resolve-channel <discord_channel_id>
```

From the source tree:

```bash
npm run cli -- resolve-channel <discord_channel_id>
```

It prints JSON containing channel ID, Claude UUID, JSONL path, cwd, sequence, and status. Exit codes distinguish invalid input, missing mapping, stale mapping, missing JSONL, and unavailable state. It never performs snowflake-to-UUID arithmetic.

## Security

clauderemote controls a local coding agent with the operating-system permissions of the bot account. Treat it as privileged infrastructure.

- Use a private guild.
- Keep the team allowlist small.
- Prefer a dedicated OS account/container for the bot.
- Restrict `ALLOWED_CWD_PREFIXES`.
- Understand that `bypassPermissions` is dangerous.
- Never reuse or publish the Discord token.
- Review [SECURITY.md](SECURITY.md).

Output is scrubbed for common credential formats, but secret scrubbing is defense in depth—not permission to send secrets to Discord.

## Development and validation

```bash
npm run typecheck
npm run test:unit
npm test
npm run build
npm pack --dry-run
```

Or run the complete local gate:

```bash
npm run check
```

`npm run build` removes `dist` before compiling so deleted commands cannot survive as stale production artifacts. CI runs on Linux, Windows, and macOS. Production Discord integration testing should use a dedicated staging guild.

## Process lifecycle

The bot acquires a singleton PID lock. Graceful shutdown stops Claude children, pending approvals, the approval endpoint, and Discord before releasing the lock. Do not run multiple process managers.

Source changes, migrations and builds do not affect an already running process. A deliberate service restart is required to activate a new build; release tooling must never restart production implicitly.

## Documentation

- [DOCS.md](DOCS.md) — complete normative specification.
- [CONTRIBUTING.md](CONTRIBUTING.md) — development and pull-request rules.
- [SECURITY.md](SECURITY.md) — vulnerability reporting and host security boundary.
- [.env.example](.env.example) — configuration template.
- [LICENSE](LICENSE) — MIT license.

## License

MIT.
