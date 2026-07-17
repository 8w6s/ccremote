# clauderemote — Complete Product and Architecture Specification

> Status: normative project documentation. This document describes the intended public behavior, architecture, protocols, state transitions, safety boundaries, Discord interaction model, operations, and failure handling of clauderemote. When code and this document disagree, the disagreement is a bug or must be documented as a compatibility exception.

## 1. Product definition

clauderemote is a self-hosted remote control plane for the real Claude Code CLI running on a user's workstation, server, or VPS. Discord is the first frontend. The bot does not reimplement Claude Code and does not replace Claude's session store. It starts or resumes the local `claude` executable, forwards normalized user input, consumes structured events, and presents those events as safe Discord UI.

The core mapping is:

| Control-plane object | Meaning |
|---|---|
| Discord guild | The configured control center and authorization boundary |
| Discord text channel | A frontend view of one Claude Code session |
| Claude session UUID | The authoritative conversation identity |
| Claude JSONL transcript | The authoritative durable conversation record |
| Discord channel ID | The authoritative Discord-side identity |
| Channel name | A mutable display label, never an identity |
| Discord message | A prompt, rendered event, control surface, or status view |
| Local `claude` process | The live execution engine for a channel |

clauderemote is single-guild and owner-controlled in the current architecture. It may allow explicitly registered team members, but it is not a public multi-tenant bot.

## 2. Design principles

1. **Claude Code remains authoritative.** Session UUIDs and JSONL transcripts belong to Claude Code.
2. **Identity is explicit.** Never derive a Claude UUID from a Discord snowflake or channel name.
3. **One event model, one renderer.** Live output and JSONL replay normalize into the same intermediate events and use the same Discord renderer.
4. **State changes are idempotent.** Repeated gateway events, filesystem notifications, button clicks, and process callbacks must not duplicate output or apply an action twice.
5. **Interactive controls are correlated.** Every approval, question, tool result, and task update is tied to its real request/tool/session identity.
6. **Discord is a constrained frontend.** Pagination, attachments, modals, and message edits preserve semantics within Discord limits.
7. **No guessed protocols.** Optional Claude features are enabled only when official documentation or observed runtime payloads establish their schema.
8. **Fail closed for authority and persistence.** Corrupt state must never silently become an empty database; unknown approvals must deny.
9. **Destructive actions are explicit and auditable.** Deletion requires confirmation and survives partial failure through recoverable state.
10. **No UI spam.** Streaming, progress, tools, approvals, and tasks update existing control messages where possible.

## 3. System topology

```text
Discord gateway / REST
        │
        ▼
Input authorization and normalization
        │
        ▼
Channel ↔ Session mapping store
        │
        ▼
Runner lifecycle manager ───── Local Claude Code CLI
        │                         │
        │ structured live events │ JSONL transcript
        ▼                         ▼
       Event normalization adapters
                    │
                    ▼
          Canonical InteractionEvent
                    │
                    ▼
             Discord Renderer
                    │
          send/edit/disable/attach
                    ▼
                 Discord
```

Supporting services include the approval prompt bridge, JSONL mirror, sequence allocator, task cache, attachment store, notification preferences, team allowlist, process singleton lock, and deterministic resolver CLI.

## 4. Identity model

### 4.1 Authoritative keys

A session mapping contains at least:

```ts
interface SessionMapping {
  guildId: string;
  discordChannelId: string;
  claudeSessionUuid: string | null;
  jsonlPath: string | null;
  cwd: string;
  sequenceNumber: number;
}
```

Required uniqueness:

- `discordChannelId` is globally unique in the store.
- `(guildId, claudeSessionUuid)` is unique when the UUID is non-null.
- `(guildId, sequenceNumber)` is unique.
- A channel name is never used to resolve any of these values.

### 4.2 Session sequence

The stable display sequence uses `s-NNNN-NNNN`:

- Sequence 1 → `s-0000-0001`.
- Sequence 9999 → `s-0000-9999`.
- Sequence 10000 → `s-0001-0000`.

The first bootstrap discovers local JSONL transcripts and sorts them by:

1. First valid timestamp inside the JSONL.
2. Filesystem birth time.
3. Filesystem modification time.
4. UUID and path as deterministic tie breakers.

Existing assignments never move. A transcript copied in later receives the next free sequence even if its historical timestamp is older.

### 4.3 Channel naming

The default active name is `🟣-s-NNNN-NNNN`. During initial synchronization, the leading marker is temporarily replaced with `[P%]`. A completed sync restores `🟣`. An error may use an explicit error prefix.

Manual rename changes presentation only. It never changes UUID, mapping, JSONL path, or sequence number.

## 5. Persistent state

The state store records:

- Guild ID, channel ID, Claude UUID, JSONL path, cwd, sequence.
- Source: Discord, local CLI import, or branch.
- Created and last-activity timestamps.
- Active/closed/deleted lifecycle state.
- Model, effort, permission mode, goal, loop configuration.
- Runner and pending-prompt recovery metadata.
- Sync state, byte checkpoint, total bytes/events, and mapping health.
- Destructive-operation tombstones and audit metadata where applicable.

Persistence requirements:

- Writes use a temporary file and atomic replace.
- The store has an explicit schema version and runtime validation.
- A last-known-good backup is retained.
- A malformed primary store is quarantined and recovered from backup, or startup fails closed.
- Corruption must never be interpreted as an empty store.
- Migrations are monotonic, idempotent, and preserve unknown forward-compatible fields.
- The singleton process policy does not replace storage-level uniqueness checks.

Mapping health values:

| State | Meaning |
|---|---|
| `healthy` | Channel, UUID, and expected JSONL relationship are valid |
| `stale` | The mapped Discord channel is missing or inaccessible |
| `missing-jsonl` | Mapping exists but its local transcript is missing |
| `duplicate` | More than one mapping claims the same authoritative identity |

Startup reconciliation detects inconsistencies but does not destroy uncertain user data automatically.

## 6. Runner lifecycle

One live Runner may exist per channel. `Bridge.getOrCreate()` is singleflight: concurrent prompts wait for the same startup promise. A Runner starts the local `claude` binary using structured stream input/output and the current session configuration.

Runner states are conceptually:

```text
absent → starting → idle → processing → idle
                     │         │
                     ├────────► stopping → absent
                     └────────► crashed → cooldown → absent
```

Rules:

- A closed, syncing, read-only, stale, or duplicate mapping cannot start a Runner.
- Configuration changes that require a new CLI process are deferred until the active turn completes.
- Intentional stop/reconfigure is not counted as a crash.
- Repeated crashes trigger a bounded per-channel cooldown.
- Typing starts only after a valid request is accepted and stops in every success/error/cancel/finally path.
- Pending approvals are denied and disabled when the Runner exits.
- Graceful service shutdown stops child processes before releasing the singleton lock.

## 7. Canonical event pipeline

Live CLI events and JSONL records normalize into canonical events such as:

- `UserPrompt`
- `AssistantTextDelta`
- `AssistantTextEnd`
- `ToolUse`
- `ToolResult`
- `ToolRunningStatus`
- `AskQuestionsRequest`
- `ToolApprovalRequest`
- `EditApprovalRequest`
- `PlanApprovalRequest`
- `TaskListUpdate`
- `ErrorEvent`
- `WarningEvent`

Thinking blocks, graph continuation internals, session bookkeeping, and other non-user-facing internal records are ignored. Unknown events are logged with bounded/scrubbed metadata and do not crash replay.

Every event carries enough correlation data to distinguish session, turn, parent tool, tool-use ID, and source. Tool results update the card belonging to the exact `tool_use_id`; arrival order alone is never used for pairing.

## 8. Discord input normalization

The raw Discord input contains message content, attachments, stickers, reply reference, source message ID, channel ID, and mapped session UUID. It normalizes to:

```ts
interface NormalizedRequest {
  text: string;
  inlineAttachments: InlineTextAttachment[];
  fileAttachments: FileAttachmentReference[];
  inlineImages: ImageBlock[];
  sourceMessageId: string;
  channelId: string;
  sessionUuid: string | null;
}
```

Normalization rules:

- Preserve ordinary text and Unicode emoji.
- Remove static and animated custom Discord emoji tokens.
- Ignore stickers.
- If nothing remains and there are no valid files/images, do not start/resume Claude and do not send an empty prompt.
- Preserve visible message content when attachments exist.
- Include bounded reply context before the new content.
- Treat a Discord-generated oversized `messages.txt` as textual continuation while preserving filename and line breaks.
- Inline small text/code files with a clear filename/length delimiter.
- Store large text and binary files temporarily and pass their absolute path plus metadata.
- Never execute, open, or shell-expand an attachment.

## 9. Attachment handling

Temporary files use the operating-system temp directory:

```text
<os temp>/clauderemote/<session-or-channel>/<message>/<collision-safe filename>
```

Safety requirements:

- Sanitize basename and remove absolute/path traversal semantics.
- Use collision-resistant names; never overwrite.
- Enforce advertised and streamed byte limits.
- Apply download timeout and abort handling.
- Detect text using content evidence: null bytes, strict UTF-8, BOM, printable ratio, MIME, and extension hints.
- Preserve text line breaks.
- Never trust MIME or extension alone.
- Redact signed URL query parameters from logs.
- Maintain a lease while a Runner/tool may use a file.
- Cleanup by message/session and TTL; perform safe stale cleanup on startup.
- Inline image count and size are bounded.

## 10. Output and streaming

Assistant streaming creates at most one active Discord message per output segment. Deltas append to an in-memory buffer. A coalescer edits at a safe interval.

The coalescer invariant is:

- Only one edit callback may be executing.
- Scheduling during an edit sets a pending flag.
- Completion immediately flushes pending data.
- `channel.send()` creation is guarded atomically so two concurrent flushes cannot create two messages.
- Discord length limits split at semantic boundaries without corrupting token accounting.

Tool cards transition in place:

```text
queued/running → succeeded
              → failed
              → denied
              → cancelled
```

Long output is truncated in the card and may be attached as a file. Errors use red accents; warnings use yellow/orange; success uses green. All displayed content passes secret scrubbing.

## 11. Approval protocol

Permission requests originate from Claude Code's permission protocol and are correlated by channel plus tool-use/request ID. Approvals are serialized per channel so parallel tools cannot expose several actionable decisions out of order.

### 11.1 Generic/Bash approval

The control surface may contain:

- Command or tool input.
- cwd.
- Claude-provided description/reason.
- Approve once.
- Always allow only when real `permission_suggestions` exist.
- Deny.
- Amend where supported.
- Explain.
- Cancel.

Approve once returns the current/updated input without persistent permission suggestions. Always allow returns the selected real suggestions through `updatedPermissions`. No allow rule is invented.

### 11.2 Edit and Write approval

The card shows file path, change kind, and diff. Small diffs are inline. Large diffs become attachments with a bounded summary. Actions are Approve, Deny, and Amend/request changes when supported.

### 11.3 Plan approval

`ExitPlanMode` is not a generic Bash approval. It renders plan text, plan file path, and implementation permissions if supplied. The actions are Approve plan and Keep planning. Long plans are attached. Runtime parsing is defensive and follows documented fields.

### 11.4 Completion and stale controls

Once resolved, every component on the old control message is disabled and the outcome is displayed exactly once. A repeated click is acknowledged ephemerally as stale. A request is namespaced by guild, channel, session, and request ID. Timeout auto-denies.

## 12. AskUserQuestion

A question request owns one editable control message and a question-state registry.

Supported semantics:

- One or many questions.
- Single select (`max_values = 1`).
- Multi select (`min_values = 0`, bounded `max_values`).
- Option title and description.
- Recommended marker retained compactly.
- Previous/Next navigation.
- Question X/Y display.
- Custom answer through a modal.
- Chat about the question.
- Submit even when some questions are unanswered.
- Cancel.

Discord allows at most 25 select options. Requests exceeding that limit must paginate; they must never silently discard questions/options. State updates are serialized to prevent two clicks from overwriting each other. Submission returns the original questions together with the answer mapping expected by Claude Code.

## 13. Tasks and todos

Task state is isolated per session/channel. `TaskCreate`, `TaskUpdate`, and compatible Todo events update a cached model. A channel has at most one task dashboard message, which is edited in place.

Status display:

- `☐` pending.
- `⏳` in progress.
- `☑` completed.

Title is always displayed. Description, active form, progress, and known metadata are included within Discord limits. Deleted/empty task state removes or disables the dashboard; it never creates or pins an `(empty)` widget. Cache may be rebuilt deterministically from JSONL.

## 14. JSONL synchronization

### 14.1 Initial import

The importer discovers transcripts, creates or reuses exactly one mapped channel per UUID, then replays records in file order through the canonical event renderer.

Progress shows:

- Processed event count and total.
- Byte checkpoint and total.
- Percentage.
- ETA when meaningful.
- Running/completed/error state.

### 14.2 Exactly-once contract

A durable render ledger records the source event identity or exact byte range and resulting Discord message identity/state. A checkpoint advances only after rendering and ledger persistence succeed. Restart resumes at a complete JSONL record boundary. Replaying an already committed event reuses/updates its mapped Discord message instead of sending another.

Tool-use and tool-result events are joined by their real IDs even when separated or delayed.

### 14.3 Live tail

After initial sync, a watcher tails appended complete lines. Filesystem notifications are hints, not authoritative events. If a notification arrives while reading, a dirty flag schedules another read. Offset is durable. Startup reads from the committed offset before watching EOF, so events written while the bot was offline are not lost.

Truncation/rotation is detected. Partial final lines are buffered until complete. Unknown/malformed lines are logged and handled according to checkpoint policy without crashing the mirror.

### 14.4 Duplicate channel prevention

`getOrCreateSessionChannel()` uses persistent uniqueness plus in-process singleflight. If Discord channel creation succeeds but mapping insertion loses a uniqueness race, the implementation fetches the winning mapping and safely removes only the newly created, provably empty orphan.

## 15. Permission modes and effort

Permission modes:

| Mode | Meaning |
|---|---|
| `bypassPermissions` | Dangerous skip-permissions mode; no ordinary approvals |
| `auto` | Claude/runtime decides which actions require confirmation |
| `manual` | Prompt for permission according to the enforced ask policy |
| `acceptEdits` | Automatically accepts eligible edits; other actions may prompt |
| `plan` | Read-only planning semantics; ExitPlanMode has dedicated approval |

Mode is reflected in the bot's guild nickname where permitted. It is not represented by effort roles.

Effort is per session:

| Effort | Discord role color |
|---|---|
| low | yellow |
| medium | green |
| high | cyan |
| xhigh | light purple |
| max | red |
| ultracode | deep purple |

Effort roles are assigned to the bot member, not the human user. The previous effort role is removed before the new one is added. `auto` removes explicit effort roles. Runtime capability differences, such as an older Claude version not accepting a level, must produce a clear fallback rather than silently misreporting state.

## 16. Commands

All commands are guild-scoped. Except where noted, only the configured owner or allowlisted team members may invoke them. Session commands require a valid mapped session channel. Responses that contain private paths, state, or errors are ephemeral when practical.

### `/new`

Creates a new mapped session channel under the active category. It allocates the next stable sequence, persists mapping state, posts a session header, and returns a channel mention. If persistence fails after Discord creation, only the new orphan is rolled back.

### `/close`

Stops the Runner, cancels approvals, marks the session closed, cleans eligible temporary files, prefixes/renames the channel, and moves it to the configured archive category. JSONL and mapping remain. A message in the archived channel or `/open` can reopen it.

### `/open`

Valid only for a closed mapped session. It moves the channel back to the active category, clears the closed marker, preserves UUID/history, and leaves Runner creation lazy until the next prompt.

### `/delete confirm:true`

Permanently deletes the exact mapped JSONL, state mapping, temporary files, watcher, approval endpoint registration, Runner, and Discord channel. It uses a durable deletion state machine so partial failure is retryable. It never derives a different UUID or deletes a sibling transcript. `confirm:false` performs no mutation.

### `/rename name:<value>`

Changes only the channel display name after Discord-safe normalization. UUID, sequence, JSONL path, and mapping remain unchanged. Discord rename rate limits are surfaced clearly.

### `/branch`

Creates a new channel derived from the current transcript. The new channel immediately displays sync progress, replays the complete visible transcript, and then becomes an independent fork when activated. Source UUID and new channel identity are recorded separately.

### `/fork`

Creates a new Claude UUID lineage in the same Discord channel using Claude's fork-session behavior. It preserves the parent transcript and updates mapping only after the fork transition is valid.

### `/sync-sessions`

Discovers every unmapped Claude JSONL transcript on the machine and queues imports. Already mapped UUIDs are skipped. Each import is singleflight, resumable, sequence-assigned, and independently reports progress/error.

### `/status`

In a session channel, shows sequence, channel ID, UUID, created/last-active times, JSONL path/existence, cwd, source, sync state/progress/checkpoint, model, mode, effort, Runner/current tool, live/offline state, temporary attachment directory, and mapping health. Outside a session, shows a bounded global overview. Output is ephemeral.

### `/cwd path:<absolute path>`

Canonicalizes symlinks, requires an existing directory inside `ALLOWED_CWD_PREFIXES`, safely stops/reconfigures the Runner, and starts a new session identity for the new project directory on the next prompt.

### `/model model:<name>`

Persists the per-session model override and applies it on the next Runner configuration. Changes during a turn are deferred until the turn completes.

### `/mode mode:<value>`

Persists the permission mode, updates the bot nickname when allowed, and reconfigures after the active turn. Plan mode retains dedicated semantics.

### `/effort level:<value>`

Persists reasoning effort, synchronizes exactly one bot-member effort role, and reconfigures the Runner. `auto` restores the model default. `ultracode` may be implemented as a compatible composite preset when native runtime support is absent.

### `/clear confirm:<boolean>`

Requests Claude Code to clear active context while preserving historical JSONL. False confirmation does nothing.

### `/compact focus:<optional text>`

Requests native Claude context compaction, optionally specifying what the summary must preserve.

### `/context`

Requests the detailed native context view only when the configured endpoint is the official Anthropic API. Custom gateways receive an explicit unsupported explanation because their token breakdown cannot be assumed compatible.

### `/usage`

Requests Claude Code's native usage/cost view. Custom gateways may omit or reinterpret pricing, which is disclosed.

### `/btw text:<prompt>`

Sends a normal turn tagged as a visually distinct quick aside. It uses the same queue, Runner, accounting, and completion behavior as an ordinary prompt.

### `/stop`

Sends an abort signal to the active Runner turn. It does not fabricate a successful completion mention and does not delete the session.

### `/rewind`

Reads prior user prompts from the exact mapped JSONL and presents an ephemeral, paginated select. The cache is bounded and expires. Selecting an item displays it; it does not automatically resend it.

### `/task`

Shows the current session's task list ephemerally. If runtime cache is empty and JSONL exists, it hydrates from that transcript. It never mixes sessions.

### `/goal`

Manages a persistent bot-side objective with `set`, `status`, `complete`, `blocked`, and `clear`. An active goal is injected as bounded context into ordinary prompts. Goal status is coordination metadata, not a Claude Code native protocol.

### `/loop`

Manages recurring prompt intent with `start`, `status`, and `stop`. Stop cancels all locally tracked wakeups for that session. Loop execution obeys the same authorization, rate, Runner, and error controls as manual prompts.

### `/skill name:<skill> args:<optional>`

Lists local Claude skills for autocomplete and invokes the selected slash skill through the Runner. Names are treated as Claude input, not shell commands.

### `/reload-skills`

Reconfigures the CLI process after the current turn so newly edited local skills are loaded by the next Runner.

### `/diff`, `/doctor`, `/init`, `/recap`

These forward the corresponding native Claude Code command through the normal session pipeline and render its structured output. They are not reimplemented by clauderemote.

### `/git`

Runs a constrained native Git subcommand in the canonical allowed cwd without consuming a Claude turn. It uses argument arrays rather than shell concatenation, bounds output, and rejects unsupported operations.

### `/team add|remove|list`

Owner-only allowlist management. Members gain permission to use the bot but cannot manage the allowlist. Mentions in responses use safe allowed-mention behavior.

### `/handoff user:<user>`

Grants an authorized user access to the relevant Discord channel according to the configured team/channel policy. It does not transfer session ownership or expose other channels.

### `/notify`

Toggles completion notification preference. A successful eligible turn mentions the requester at most once. Cancelled, ignored, replayed, or duplicated completion events do not mention anyone.

### `/ping`

Performs a lightweight bot interaction sanity check without starting Claude.

### `/claude-help`

Shows a concise feature map distinguishing Discord-native controls, mapped Claude UI, features invoked through Claude, and terminal-only operations.

## 17. Component-level interaction contract

Every Discord component custom ID contains a namespaced operation and an opaque request/cache identity. IDs remain below Discord's length limit and never embed secrets, file contents, prompts, or authorization data.

For each click/select/modal submit:

1. Verify guild and authorized user.
2. Resolve the current registry entry.
3. Verify channel/session/request ownership.
4. Reject stale/resolved/expired entries ephemerally.
5. Serialize mutation for that request.
6. Edit the control message or show the modal.
7. Acknowledge the interaction within Discord's deadline.
8. Persist terminal state before resolving the Claude-side request.

Select menus paginate beyond 25 options. Action rows never exceed five components, and a message never exceeds Discord's component-row limit. Labels, descriptions, modal values, embeds, text displays, filenames, and attachments are explicitly bounded.

## 18. Authorization and security

- Ignore bot-authored messages.
- Ignore DMs and all guilds except `GUILD_ID`.
- Require owner or team membership for messages, slash commands, autocomplete, buttons, selects, and modals.
- Owner-only operations include team administration and any future global destructive command.
- Canonicalize cwd and enforce configured roots against symlink escapes.
- Use `spawn` argument arrays; never interpolate untrusted input into a shell.
- Scrub secrets before Discord rendering and logs.
- Do not log bot tokens, API credentials, signed attachment URLs, full environment dumps, or unbounded tool payloads.
- Default dangerous permission mode is prominently documented and configurable.
- Discord channel permissions are defense in depth, not a replacement for application authorization.

## 19. Completion, notifications, and typing

Typing is renewed because Discord indicators expire automatically. A stale deadline stops it if the event stream freezes. The timer is cleared on result, error, abort, process exit, channel close/delete, and shutdown.

Completion mentions are keyed by turn/request and sent once only after successful non-replay completion. JSONL historical sync never mentions users. Notification preference may add DM/channel behavior only when explicitly configured.

## 20. Resolver CLI

```bash
clauderemote resolve-channel <discord_channel_id>
```

Default output is machine-readable JSON:

```json
{
  "channelId": "123",
  "sessionUuid": "uuid",
  "jsonlPath": "/path/session.jsonl",
  "cwd": "/project",
  "status": "ok"
}
```

Exit codes distinguish success, invalid input, unmapped channel, stale mapping, missing JSONL, and unavailable/corrupt state. Resolution uses the mapping store only; Discord snowflake arithmetic is never involved.

## 21. Startup sequence

1. Validate configuration without printing secrets.
2. Ensure and validate state storage.
3. Acquire the singleton lock atomically.
4. Load commands and events.
5. Login to Discord.
6. Start the local approval endpoint before any Runner.
7. Migrate state and bootstrap transcript sequences.
8. Ensure the hub control message.
9. Reconcile archive placement and mapping health.
10. Recover interrupted destructive operations and pending prompts.
11. Resume checkpointed imports.
12. Catch up durable JSONL offsets, then arm live watchers.

Startup errors in identity/persistence fail closed. A Discord UI convenience failure may degrade gracefully when it does not risk mapping or data integrity.

## 22. Shutdown sequence

On SIGINT/SIGTERM:

1. Stop accepting new turns.
2. Stop typing and schedulers.
3. Resolve/deny pending approvals.
4. Stop JSONL watchers.
5. Stop all Claude child processes with bounded escalation.
6. Stop the approval endpoint.
7. Flush state/audit data.
8. Destroy the Discord client.
9. Release the singleton lock only if owned by this process.

Uncaught exceptions must not leave a potentially corrupted process running indefinitely.

## 23. Configuration

Required variables:

- `BOT_TOKEN`
- `CLIENT_ID`
- `GUILD_ID`
- `OWNER_ID`
- `HUB_CHANNEL_ID`
- `CATEGORY_ID`

Important optional variables:

- `ARCHIVE_CATEGORY_ID`
- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN`
- `DEFAULT_CWD`
- `ALLOWED_CWD_PREFIXES`
- `MAX_PROMPTS_PER_HOUR`
- `MAX_ATTACHMENT_BYTES`
- `MAX_IMAGE_BYTES`
- `MAX_INLINE_IMAGES`
- `MAX_INLINE_TEXT_BYTES`
- `ATTACHMENT_DOWNLOAD_TIMEOUT_MS`

Defaults use `os.homedir()`, `os.tmpdir()`, and platform path APIs rather than assuming `HOME` or `/tmp`.

## 24. Observability and audit

Logs are structured enough to correlate guild, channel, session, turn, request, and tool ID. Sensitive content is scrubbed. Expected user errors are not stack-trace noise. Durable audit entries cover mapping changes, approvals, team changes, deletion phases, recovery decisions, and reconciliation.

Metrics worth exposing include active Runners, pending approvals, sync queue depth, watcher lag, Discord REST retries, render latency, duplicate suppression count, state recovery count, and attachment cleanup totals.

## 25. Testing contract

Minimum automated coverage includes:

- Input normalization for visible text, `messages.txt`, text/binary files, Unicode/custom emoji, and stickers.
- Filename traversal, collision, size, timeout, and cleanup leases.
- Deterministic sequence bootstrap and no-renumber behavior.
- State migration, corruption recovery, atomic replacement, and backup fallback.
- Duplicate channel races and post-create uniqueness conflicts.
- Resolver success and every exit-code failure.
- JSONL record-boundary checkpoints, crash resume, no duplicate render, delayed tool results, partial lines, CRLF, truncation, and writes during processing.
- Streaming send/edit reentrancy.
- Task isolation, deletion, hydration, and single-dashboard behavior.
- AskUserQuestion single/multi/custom/partial submit, descriptions, pagination, stale and concurrent interactions.
- Approve once versus Always permission semantics.
- ExitPlanMode dedicated semantics.
- Partial `/delete` recovery.
- `/status` rendering and Discord size bounds.
- Authorization for every interaction type.
- Clean build proving deleted source commands cannot survive in `dist`.

CI runs formatting/lint, typecheck, unit tests, clean build, loader smoke test, package-content validation, secret scan, and dependency audit. Discord integration tests use mocks or a dedicated staging guild and never the production bot token.

## 26. Release contract

A release is ready only when:

- The repository is clean and contains no `.env`, token, state, transcript, temp attachment, or runtime lock.
- Build starts from an empty output directory.
- Tests, typecheck, build, and package audit pass.
- README behavior matches code and this specification.
- Migration and rollback notes exist.
- Package metadata includes Node engine, repository, bugs, homepage, and explicit published files.
- CI is green on supported operating systems.
- The staged file list and package tarball are manually inspected.
- A restart/deployment requirement is stated explicitly; development tooling never silently restarts production.

## 27. Explicit non-goals

- Reimplementing Claude's model, planner, skills, hooks, or MCP ecosystem.
- Treating Discord as the authoritative transcript database.
- Rendering private thinking/internal events.
- Guessing unsupported PushNotification or tool schemas.
- Parsing Discord snowflakes into Claude UUIDs.
- Executing arbitrary attachments.
- Supporting public untrusted multi-tenancy without a redesigned isolation model.

## 28. Compatibility and defensive parsing

Claude Code evolves. Parsers therefore accept known compatible aliases, retain unknown optional data for logs/audit, and reject unsafe ambiguity. Official documentation defines intended semantics; observed runtime payloads may add defensive compatibility. Any divergence is recorded with Claude version and sanitized sample shape.

Discord also evolves. Component construction is centralized, all hard limits are tested, and deprecated behavior is not assumed to remain available.

## 29. Operational recovery scenarios

### Bot crashes during a turn

The pending-prompt marker survives. Startup warns the channel, reconciles the JSONL offset, disables stale controls, and resumes only on explicit new input unless the runtime protocol guarantees safe continuation.

### Bot crashes during transcript import

The durable checkpoint/ledger resumes from the last committed complete event. Existing Discord messages are reused, not duplicated.

### Discord channel is manually deleted

The mapping is marked stale/deleted. If policy enables recovery and the JSONL is confirmed, one replacement channel is created through the same uniqueness transaction. Uncertain duplicates are reported, not destroyed.

### JSONL disappears

Mapping becomes `missing-jsonl`. The channel remains for diagnosis. The bot does not create a new session under the old identity silently.

### State file is corrupt

The primary is quarantined, backup is validated, and startup either recovers or fails closed with recovery instructions. It never starts with `{}` automatically.

### Discord REST edit fails

The renderer applies bounded retry/backoff where safe. It preserves correlation state and does not send a duplicate replacement unless it can prove the original does not exist.

### Permission UI cannot render

The request is denied with an explicit reason. Claude is never silently auto-approved.

## 30. Glossary

- **Runner:** One managed local Claude CLI process associated with a channel.
- **Mapping:** Persistent relationship between Discord channel and Claude session identity.
- **Mirror:** JSONL-to-Discord rendering path for local CLI activity or imports.
- **Renderer:** Shared component that maps canonical events to Discord messages/components.
- **Control message:** Editable Discord message that owns an approval, question, task dashboard, or progress UI.
- **Checkpoint:** Durable position after a completely committed JSONL event.
- **Render ledger:** Durable mapping from source event identity to Discord render identity.
- **Singleflight:** Concurrent requests for the same resource share one in-progress operation.
- **Stale interaction:** A component action whose request has expired, completed, restarted, or no longer matches its session.
- **Read-only import:** A mirrored session whose cwd is outside the configured execution roots.
