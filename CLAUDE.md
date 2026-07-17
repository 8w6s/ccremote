# clauderemote development guide

Read [DOCS.md](DOCS.md) before changing behavior. It is the normative product, architecture, protocol, interaction, persistence, security, and recovery specification.

## Purpose

clauderemote is a Discord control plane for the real local Claude Code CLI. It spawns the `claude` executable rather than using an SDK so the runtime keeps Claude Code's native system prompt, configuration, skills, hooks, MCP servers, and JSONL session behavior.

Discord is a frontend, not the authoritative transcript store:

- One configured Discord guild is the control boundary.
- One Discord text channel represents one Claude session.
- Claude session UUID is the authoritative conversation identity.
- Discord channel ID is the authoritative Discord identity.
- Channel name is a mutable display label only.
- Claude JSONL is the authoritative transcript.

## Required development workflow

1. Preserve user data and unrelated working-tree changes.
2. Do not restart, stop, kill, deploy, or replace a running bot unless explicitly requested.
3. Use `apply_patch` for normal source edits.
4. Add a regression test for every bug fix.
5. Run `npm run typecheck`, `npm run test:unit`, `npm test`, and `npm run build`.
6. Inspect `npm pack --dry-run` and run `npm audit --omit=dev` before release.
7. Keep all code comments, logs, commands, UI, documentation, and release metadata in English.

## Architecture

```text
Discord message/interaction
        │
        ▼
authorization + input normalization
        │
        ▼
channel/session mapping + Runner
        │
        ├── structured live Claude events
        └── Claude JSONL events
                    │
                    ▼
           canonical interaction events
                    │
                    ▼
             shared Discord renderer
```

Live Runner output and JSONL replay must never grow separate rendering semantics. Add new user-visible behavior to the canonical event model and shared renderer.

## State and identity

State is stored below `$XDG_STATE_HOME/clauderemote` with a home-state fallback. Claude transcripts remain in Claude Code's own project storage.

Persistence rules:

- Never resolve a session by channel name.
- Never derive a UUID from a Discord snowflake.
- Keep channel ID, guild ID, UUID, JSONL path, cwd, and sequence explicitly mapped.
- Fail closed when state is corrupt; recover only from a validated backup.
- Preserve uniqueness for guild/session UUID, channel ID, and guild/sequence.
- Startup reconciliation reports uncertain duplicates instead of deleting user data.

## Runner and permissions

Only one live Runner may exist per channel. Concurrent startup uses singleflight. Intentional reconfiguration does not count as a crash. Configuration changes during an active turn are deferred where interruption would corrupt the workflow.

Permission rules:

- Approve Once must not return persistent permission suggestions.
- Always Allow is displayed only when Claude supplies real suggestions.
- Always Allow returns those suggestions through `updatedPermissions`.
- ExitPlanMode uses dedicated plan UI.
- Unknown or unrenderable approval requests fail closed.
- Pending approvals are serialized per channel and correlated by real request/tool identity.

## Discord UI

All Discord limits must be explicit and tested:

- Maximum 25 select options; paginate instead of truncating.
- Maximum five buttons per action row.
- Bound custom IDs, labels, descriptions, modal values, text blocks, filenames, and attachments.
- Disable resolved controls.
- Reject stale interactions ephemerally.
- Edit task, progress, streaming, and tool messages in place instead of spamming.

Do not render private thinking or internal Claude events.

## Attachments

Normalize all input before starting Claude:

- Preserve Unicode emoji.
- Strip Discord custom emoji tokens.
- Ignore stickers.
- Ignore empty/custom-emoji-only/sticker-only requests.
- Preserve visible text alongside attachments.
- Inline small text/code safely.
- Store large text and binary data below `os.tmpdir()` with sanitized collision-safe names.
- Enforce download size and timeout while streaming.
- Never execute or shell-expand attachment names.
- Never log full signed attachment URLs.

## Important files

- `src/lib/runner.ts` — Claude process lifecycle and structured stream protocol.
- `src/lib/renderer.ts` — shared Discord rendering and streaming state.
- `src/lib/interactionEvents.ts` — canonical event model and JSONL normalization.
- `src/lib/jsonlMirror.ts` — checkpointed import and live transcript tail.
- `src/lib/state.ts` — durable session mapping and migration.
- `src/lib/sequenceRegistry.ts` — stable display sequence allocation.
- `src/lib/approvalMcpServer.ts` — local Claude permission bridge.
- `src/lib/approvalRegistry.ts` — approval/question correlation and queues.
- `src/lib/approvalUI.ts` — Discord approval and AskUserQuestion controls.
- `src/lib/inputNormalizer.ts` — normalized Discord request model.
- `src/lib/attachments.ts` — safe attachment download, classification, and cleanup.
- `src/lib/sessionSync.ts` — local transcript discovery and channel import.
- `src/events/messageCreate.ts` — authorized prompt entry point.
- `src/events/interactionCreate.ts` — slash/component/modal dispatch and authorization.

## Commands

The complete contract for every command is in [DOCS.md](DOCS.md#16-commands). Commands must be guild-scoped, authorized, and session-guarded where appropriate. Sensitive state and paths should be returned ephemerally.

## Validation

```bash
npm run typecheck
npm run test:unit
npm test
npm run build
npm pack --dry-run
npm audit --omit=dev
```

`npm run build` must start from an empty `dist` directory so removed commands cannot survive as stale production artifacts.

## Environment

Required values are documented in `.env.example`: `BOT_TOKEN`, `CLIENT_ID`, `GUILD_ID`, `OWNER_ID`, `HUB_CHANNEL_ID`, and `CATEGORY_ID`. Never commit `.env`, local state, JSONL transcripts, logs, PID files, or temporary attachments.
