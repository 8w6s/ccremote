import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Renderer, TurnResult, TodoItem, SessionChannel } from './renderer';
import { config } from '../config';
import {
  getSession,
  updateSessionUuid,
  touchSession,
  markPromptPending,
  clearPromptPending,
  clearSessionForkSource,
  markSessionRecapGenerated,
  updateBackgroundStatus,
} from './state';
import { getNotify } from './notify';
import { jsonlMirror } from './jsonlMirror';
import { cleanupChannelApprovals } from './approvalRegistry';
import { approvalMcpServer } from './approvalMcpServer';
import { log } from './logger';
import { customApiEnvironment } from './customApi';

/**
 * Runner manages a background Claude CLI process in print/stream-json mode.
 *
 * - abort() → SIGINT process (Claude Code CLI handle interrupt)
 * - stop() → kill process, close stdin
 *
 * CLI event schema giống SDK (same runtime).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SDKMessage = any;

export function claudeExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_BIN?.trim() || 'claude';
}

interface RunnerOpts {
  model?: string | null;
  onExit?: (channelId: string, crashed: boolean) => void;
}

export class Runner {
  static readonly AUTO_RECAP_IDLE_MS = 3 * 60_000;
  private channelId: string;
  private renderer: Renderer;
  private child: ChildProcess | null = null;
  private stopped = false;
  private spawnFailed = false;
  private sessionRotated = false;
  private onExit?: (channelId: string, crashed: boolean) => void;
  private claudeSessionId: string | null;
  private previousSessionId: string | null = null;
  private cwd: string;
  private model: string | null;
  private effort: NonNullable<ReturnType<typeof getSession>>['effort'];
  private permissionMode: string;
  private forkFromUuid: string | null;

  // Turn state
  private currentTurnModel: string | undefined;
  private currentTurnUsage: Record<string, number> = {};
  private currentTurnThinkingTokens = 0;

  // Cache thinking preview per parent_tool_use_id
  private thinkingBuffer = new Map<string, string>();
  private thinkingTokens = new Map<string, number>();

  // Incremental stdout line buffer.
  private stdoutBuf = '';

  // Turn timing used by completion notifications.
  private turnStartedAt = 0;
  private lastPromptUserId: string | null = null;
  private completionMentionedForTurn = false;
  private afterTurnCallbacks: Array<() => void> = [];
  private automaticRecapTimer: NodeJS.Timeout | null = null;
  private currentTurnIsAutomaticRecap = false;
  private currentTurnTag: string | null = null;
  private capturedContextOutput = '';

  /**
   */
  private pendingReplayPrompt: {
    text: string;
    images: Array<{ base64: string; mediaType: string }>;
    fromUserId?: string;
    echoOpts?: { accentColor?: number; tag?: string; internal?: boolean; automaticRecap?: boolean };
  } | null = null;

  private respawnAttempts = 0;
  private static readonly MAX_RESPAWN_ATTEMPTS = 3;

  /** MCP config JSON path (từ approvalMcpServer.registerChannel). Set async. */
  private mcpConfigPath: string | null = null;
  private manualSettingsPath: string | null = null;

  /**
   */
  private abortRequested = false;

  constructor(channel: SessionChannel, opts: RunnerOpts = {}) {
    this.channelId = channel.id;
    this.renderer = new Renderer(channel);
    this.onExit = opts.onExit;

    const row = getSession(this.channelId);
    if (!row) {
      throw new Error(`Runner: session state does not exist for ${this.channelId}`);
    }
    this.claudeSessionId = row.sessionUuid;
    this.cwd = row.cwd;
    this.model = opts.model ?? row.model ?? null;
    this.effort = row.effort ?? null;
    this.permissionMode = row.permissionMode ?? 'bypass';
    this.forkFromUuid = row.forkFromUuid ?? null;

    if (!this.claudeSessionId && !this.forkFromUuid) {
      this.claudeSessionId = randomUUID();
      updateSessionUuid(this.channelId, this.claudeSessionId);
    }

  }

  async start(): Promise<void> {
    if (this.child || this.stopped) return;
    this.mcpConfigPath = await approvalMcpServer.registerChannel(this.channelId);
    this.spawnCli();
  }

  getRenderer(): Renderer {
    return this.renderer;
  }

  getCurrentTool(): string | null {
    return this.renderer.getCurrentTool();
  }

  /**
   */
  isAlive(): boolean {
    if (this.stopped || this.spawnFailed) return false;
    return !!this.child && !this.child.killed && this.child.exitCode === null;
  }

  isTurnActive(): boolean {
    return this.turnStartedAt > 0;
  }

  afterCurrentTurn(callback: () => void): void {
    if (!this.isTurnActive()) {
      callback();
      return;
    }
    this.afterTurnCallbacks.push(callback);
  }

  /**
   * Claude project path encoding for an absolute cwd.
   * Example: `/home/foo/PROJECTS` becomes `-home-foo-PROJECTS`.
   */
  private sessionJsonlPath(): string | null {
    if (!this.claudeSessionId) return null;
    return this.jsonlPathFor(this.claudeSessionId);
  }

  private jsonlPathFor(uuid: string): string {
    const encoded = '-' + this.cwd.replace(/\//g, '-').replace(/^-+/, '');
    return join(homedir(), '.claude', 'projects', encoded, `${uuid}.jsonl`);
  }

  private spawnCli(): void {
    const args = [
      '-p',
      '--input-format=stream-json',
      '--output-format=stream-json',
      '--include-partial-messages',
      '--forward-subagent-text',
      '--include-hook-events',
      '--verbose',
    ];

    //   bypassPermissions | auto | manual | acceptEdits | plan
    let needsApprovalTool = false;
    switch (this.permissionMode) {
      case 'bypass':
      case 'bypassPermissions':
        args.push('--dangerously-skip-permissions');
        break;
      case 'auto':
        args.push('--permission-mode', 'auto');
        needsApprovalTool = true;
        break;
      case 'acceptEdits':
        args.push('--permission-mode', 'acceptEdits');
        needsApprovalTool = true;
        break;
      case 'plan':
        args.push('--permission-mode', 'plan');
        needsApprovalTool = true;
        break;
      case 'manual':
      case 'default':
      default:
        args.push('--permission-mode', 'manual');
        if (!this.manualSettingsPath) {
          this.manualSettingsPath = join(
            tmpdir(),
            `clauderemote-manual-${this.channelId}-${randomUUID().slice(0, 8)}.json`,
          );
          writeFileSync(
            this.manualSettingsPath,
            JSON.stringify({
              permissions: {
                ask: [
                  'Bash',
                  'Edit',
                  'Write',
                  'NotebookEdit',
                  'WebFetch',
                  'WebSearch',
                  'Agent',
                ],
              },
            }),
            { mode: 0o600 },
          );
        }
        args.push('--settings', this.manualSettingsPath);
        needsApprovalTool = true;
        break;
    }

    if (needsApprovalTool && this.mcpConfigPath) {
      args.push('--mcp-config', this.mcpConfigPath);
      args.push('--permission-prompt-tool', approvalMcpServer.getFullyQualifiedToolName());
    }

    if (this.forkFromUuid) {
      args.push('--resume', this.forkFromUuid, '--fork-session');
    } else if (this.claudeSessionId) {
      const jsonlPath = this.sessionJsonlPath();
      const hasJsonl = jsonlPath !== null && existsSync(jsonlPath);

      if (this.sessionRotated && this.previousSessionId) {
        const prevJsonl = this.jsonlPathFor(this.previousSessionId);
        if (existsSync(prevJsonl)) {
          args.push('--resume', this.previousSessionId, '--fork-session');
        } else {
          args.push('--session-id', this.claudeSessionId);
        }
      } else if (hasJsonl) {
        args.push('--resume', this.claudeSessionId);
      } else {
        args.push('--session-id', this.claudeSessionId);
      }
    }

    if (this.model) {
      args.push('--model', this.model);
    }
    if (this.effort) {
      args.push('--effort', this.effort === 'ultracode' ? 'max' : this.effort);
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ANTHROPIC_BASE_URL: config.anthropicBaseUrl || process.env.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: config.anthropicAuthToken || process.env.ANTHROPIC_AUTH_TOKEN,
      ANTHROPIC_API_KEY:
        process.env.ANTHROPIC_API_KEY || config.anthropicAuthToken || undefined,
      ...customApiEnvironment(),
    };

    const claudeBin = claudeExecutable();
    log.dim(
      `Runner[${this.channelId}] spawn: ${claudeBin} ${args.join(' ')} (cwd=${this.cwd})`,
    );

    this.child = spawn(claudeBin, args, {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.on('error', (err) => {
      const nodeErr = err as NodeJS.ErrnoException;
      log.err(`Runner[${this.channelId}] spawn error:`, err.message);
      this.spawnFailed = true;
      const hint =
        nodeErr.code === 'ENOENT'
          ? `\n-# Claude Code was not found at \`${claudeBin}\`. Re-run setup after installing the CLI.`
          : '';
      void this.renderer.postError(`Spawn claude failed: \`${err.message}\`${hint}`);
      this.onExit?.(this.channelId, true);
    });

    this.child.on('exit', (code, signal) => {
      this.renderer.stopTyping();
      log.dim(
        `Runner[${this.channelId}] exited code=${code} signal=${signal}`,
      );
      const wasRunning = this.child !== null;
      this.child = null;
      if (!wasRunning || this.stopped) return;

      if (
        this.sessionRotated &&
        code === 1 &&
        this.respawnAttempts < Runner.MAX_RESPAWN_ATTEMPTS
      ) {
        this.respawnAttempts++;
        this.sessionRotated = false;
        log.warn(
          `Runner[${this.channelId}] auto-respawn after session lock (attempt ${this.respawnAttempts}/${Runner.MAX_RESPAWN_ATTEMPTS})`,
        );
        setTimeout(() => {
          if (this.stopped) return;
          try {
            this.spawnCli();
            const pending = this.pendingReplayPrompt;
            if (pending) {
              this.pendingReplayPrompt = null;
              void this.push(
                pending.text,
                pending.images,
                pending.fromUserId,
                pending.echoOpts,
              );
            }
          } catch (err) {
            log.err(
              `Runner[${this.channelId}] respawn failed:`,
              err instanceof Error ? err.message : err,
            );
            this.onExit?.(this.channelId, true);
          }
        }, 300);
        return;
      }

      this.pendingReplayPrompt = null;
      cleanupChannelApprovals(this.channelId);

      if (code !== 0 && code !== null) {
        if (this.respawnAttempts >= Runner.MAX_RESPAWN_ATTEMPTS) {
          void this.renderer.postError(
            `⚠ Runner respawn failed ${Runner.MAX_RESPAWN_ATTEMPTS} times due to a session lock. The next prompt will retry with a fresh UUID.`,
          );
        } else {
          void this.renderer.postError(
            `Claude CLI exited unexpectedly (code=${code}${signal ? `, signal=${signal}` : ''}). The next prompt will start it again.`,
          );
        }
      }
      this.onExit?.(this.channelId, code !== 0 && code !== null);
    });

    this.child.stdout?.setEncoding('utf-8');
    this.child.stdout?.on('data', (chunk: string) => {
      this.stdoutBuf += chunk;
      let nl: number;
      while ((nl = this.stdoutBuf.indexOf('\n')) !== -1) {
        const line = this.stdoutBuf.slice(0, nl).trim();
        this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
        if (!line) continue;
        this.handleLine(line);
      }
    });

    this.child.stderr?.setEncoding('utf-8');
    this.child.stderr?.on('data', (chunk: string) => {
      const s = chunk.trim();
      log.warn(`Runner[${this.channelId}] stderr:`, s.slice(0, 400));
      if (/Session ID [\da-f-]+ is already in use/i.test(s)) {
        const oldUuid = this.claudeSessionId;
        const newUuid = randomUUID();
        log.warn(
          `Runner[${this.channelId}] session UUID ${oldUuid} is locked; forking to ${newUuid}`,
        );
        this.previousSessionId = oldUuid;
        this.claudeSessionId = newUuid;
        updateSessionUuid(this.channelId, newUuid);
        this.sessionRotated = true;
      }
    });
  }

  private handleLine(line: string): void {
    let evt: SDKMessage;
    try {
      evt = JSON.parse(line);
    } catch {
      log.warn(`Runner[${this.channelId}] non-JSON stdout:`, line.slice(0, 200));
      return;
    }
    void this.handleEvent(evt).catch((err) => {
      log.warn(
        `Runner[${this.channelId}] event handler err:`,
        err instanceof Error ? err.message : err,
      );
    });
  }

  /**
   */
  async push(
    text: string,
    images: Array<{ base64: string; mediaType: string }> = [],
    fromUserId?: string,
    echoOpts?: { accentColor?: number; tag?: string; internal?: boolean; automaticRecap?: boolean },
  ): Promise<void> {
    if (this.stopped || !this.child?.stdin || this.child.stdin.destroyed) {
      log.warn(`Runner[${this.channelId}] push: child stdin is unavailable.`);
      await this.renderer.postError(
        'Runner is unavailable, so the prompt was not sent. Retry the prompt to respawn it.',
      );
      this.onExit?.(this.channelId, true);
      return;
    }

    if (!echoOpts?.automaticRecap) this.cancelAutomaticRecap();
    this.pendingReplayPrompt = { text, images, fromUserId, echoOpts };
    this.abortRequested = false;
    this.completionMentionedForTurn = false;
    this.currentTurnUsage = {};
    this.currentTurnThinkingTokens = 0;
    this.thinkingTokens.clear();
    this.currentTurnIsAutomaticRecap = echoOpts?.automaticRecap === true;
    this.currentTurnTag = echoOpts?.tag ?? null;
    this.capturedContextOutput = '';

    if (!echoOpts?.internal) {
      await this.renderer.echoUserPrompt(
        text,
        images.length,
        echoOpts?.accentColor,
        echoOpts?.tag,
      );
    }

    markPromptPending(this.channelId);

    this.renderer.startTyping();

    const goal = getSession(this.channelId)?.goal;
    const goalAwareText = goal?.status === 'active' && !text.startsWith('/')
      ? `<persistent-goal>Continue working toward this goal until genuinely complete: ${goal.objective}</persistent-goal>\n\n${text}`
      : text;
    // Local Claude Code 2.1.212 exposes low..max only. Ultracode remains a
    // clauderemote composite preset: max native effort + one-turn keyword.
    const promptText = this.effort === 'ultracode' && !text.startsWith('/')
      ? `ultrathink\n\n${goalAwareText}`
      : goalAwareText;
    const content =
      images.length > 0
        ? [
            ...images.map((img) => ({
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: img.mediaType,
                data: img.base64,
              },
            })),
            { type: 'text' as const, text: promptText || '(no text — images only)' },
          ]
        : promptText;

    const payload = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    };
    const line = JSON.stringify(payload) + '\n';
    const ok = this.child.stdin.write(line);
    if (!ok) {
      await new Promise<void>((resolve) => this.child?.stdin?.once('drain', () => resolve()));
    }
    this.turnStartedAt = Date.now();
    this.lastPromptUserId = fromUserId ?? null;
    if (!echoOpts?.internal) touchSession(this.channelId);
    updateBackgroundStatus(this.channelId, 'running');
  }

  setAutomaticRecapEnabled(enabled: boolean): void {
    if (!enabled) this.cancelAutomaticRecap();
  }

  private cancelAutomaticRecap(): void {
    if (!this.automaticRecapTimer) return;
    clearTimeout(this.automaticRecapTimer);
    this.automaticRecapTimer = null;
  }

  private scheduleAutomaticRecap(): void {
    this.cancelAutomaticRecap();
    const session = getSession(this.channelId);
    if (!shouldScheduleAutomaticRecap(session, false) || this.stopped) return;
    this.automaticRecapTimer = setTimeout(() => {
      this.automaticRecapTimer = null;
      const latest = getSession(this.channelId);
      if (!latest?.recap?.enabled || this.stopped || this.isTurnActive()) return;
      void this.push('/recap', [], undefined, {
        tag: 'recap',
        internal: true,
        automaticRecap: true,
      });
    }, Runner.AUTO_RECAP_IDLE_MS);
    this.automaticRecapTimer.unref();
  }

  abort(): void {
    // CLI handle interrupt_receipt_v1 → return current turn gracefully.
    this.abortRequested = true;
    if (this.child && !this.child.killed) {
      this.child.kill('SIGINT');
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelAutomaticRecap();
    this.renderer.cancel();
    if (this.child) {
      try {
        this.child.stdin?.end();
      } catch {
        /* ignore */
      }
      // Give it 2s to shut down gracefully, then SIGTERM.
      const child = this.child;
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }, 2000);
      await new Promise<void>((resolve) => {
        if (!child || child.killed) {
          clearTimeout(killTimer);
          resolve();
          return;
        }
        child.once('exit', () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
    }
    if (this.manualSettingsPath) {
      try {
        unlinkSync(this.manualSettingsPath);
      } catch {
        /* ignore */
      }
      this.manualSettingsPath = null;
    }
  }

  getCwd(): string {
    return this.cwd;
  }

  private async handleEvent(evt: SDKMessage): Promise<void> {
    if (!evt || typeof evt !== 'object') return;

    // Heartbeat: mọi event từ CLI reset stale-deadline của typing indicator.
    this.renderer.bumpTyping();


    // ── system messages ──
    if (evt.type === 'system') {
      switch (evt.subtype) {
        case 'init': {
          if (evt.session_id && evt.session_id !== this.claudeSessionId) {
            this.claudeSessionId = evt.session_id;
            updateSessionUuid(this.channelId, evt.session_id);
          }
          if (this.forkFromUuid) {
            this.forkFromUuid = null;
            clearSessionForkSource(this.channelId);
          }
          this.currentTurnModel = evt.model;
          if (this.claudeSessionId) {
            const jsonlPath = this.sessionJsonlPath();
            if (jsonlPath) {
              void jsonlMirror.armWatcher(this.channelId, jsonlPath);
            }
          }
          return;
        }
        case 'thinking_tokens': {
          const k = 'root';
          const estimate = Number(evt.estimated_tokens ?? 0);
          if (Number.isFinite(estimate)) {
            this.thinkingTokens.set(k, Math.max(this.thinkingTokens.get(k) ?? 0, estimate));
          }
          return;
        }
        case 'task_started': {
          await this.renderer.postTaskStarted(
            String(evt.task_id ?? evt.taskId ?? evt.agent_id ?? evt.id ?? 'background-task'),
            evt.subagent_type ?? 'agent',
            evt.description ?? '',
          );
          return;
        }
        case 'task_updated':
        case 'task_progress':
        case 'task_notification': {
          const taskDetail = evt.message ?? evt.description ?? evt.summary ?? evt.status ?? '';
          const completed = evt.subtype === 'completed' || evt.status === 'completed';
          const failed = evt.status === 'failed' || evt.status === 'error';
          await this.renderer.postBackgroundTaskStatus(
            String(evt.task_id ?? evt.taskId ?? evt.agent_id ?? evt.id ?? 'background-task'),
            completed ? 'Background task completed' : failed ? 'Background task failed' : 'Background task update',
            typeof taskDetail === 'string' ? taskDetail : JSON.stringify(taskDetail),
            completed ? 'completed' : failed ? 'error' : 'running',
          );
          return;
        }
        case 'permission_denied': {
          const deniedToolUseId = evt.tool_use_id ?? evt.toolUseId;
          if (typeof deniedToolUseId === 'string' && deniedToolUseId) {
            await this.renderer.onToolResult(
              deniedToolUseId,
              evt.decision_reason ?? evt.message ?? 'Permission denied',
              true,
            );
          } else {
            await this.renderer.postPermissionDenied(
              evt.tool_name ?? 'tool',
              evt.decision_reason ?? evt.message ?? '',
            );
          }
          return;
        }
        case 'compact_boundary': {
          const meta = evt.compact_metadata ?? {};
          await this.renderer.postCompactBoundary(
            meta.pre_tokens,
            meta.post_tokens,
            meta.trigger,
          );
          return;
        }
        case 'hook_started':
        case 'hook_progress':
          return;
        case 'hook_response': {
          const hookOutput = evt.output ?? evt.message ?? evt.response;
          if (hookOutput) {
            await this.renderer.postSystemNotice(
              `Hook ${evt.hook_name ?? evt.hook_event ?? 'response'}`,
              typeof hookOutput === 'string' ? hookOutput : JSON.stringify(hookOutput),
              evt.exit_code != null && evt.exit_code !== 0,
            );
          }
          return;
        }
        case 'status':
          return;
        default:
          return;
      }
    }

    if (evt.type === 'stream_event') {
      const inner = evt.event;
      if (!inner) return;
      if (inner.type === 'message_start') {
        this.renderer.startTurn();
        return;
      }
      if (inner.type === 'content_block_start') {
        const cb = inner.content_block;
        if (cb && cb.type === 'tool_use' && typeof cb.id === 'string' && typeof cb.name === 'string') {
          const streamParent: string | undefined =
            typeof evt.parent_tool_use_id === 'string' ? evt.parent_tool_use_id : undefined;
          this.renderer.preRegisterTool(cb.id, cb.name, streamParent);
        }
        return;
      }
      if (inner.type === 'content_block_delta') {
        const delta = inner.delta;
        const streamParent: string | undefined =
          typeof evt.parent_tool_use_id === 'string' ? evt.parent_tool_use_id : undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          this.renderer.stopTyping();
          if (this.currentTurnTag === 'context' && !streamParent) {
            this.capturedContextOutput += delta.text;
          } else {
            await this.renderer.renderEvent({ type: 'AssistantTextDelta', text: delta.text, parentToolUseId: streamParent });
          }
        } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          const k = streamParent ?? 'root';
          this.thinkingBuffer.set(k, (this.thinkingBuffer.get(k) ?? '') + delta.thinking);
        }
        return;
      }
      if (inner.type === 'content_block_stop') {
        const streamParent: string | undefined =
          typeof evt.parent_tool_use_id === 'string' ? evt.parent_tool_use_id : undefined;
        const k = streamParent ?? 'root';
        if (this.thinkingBuffer.has(k)) {
          const tokens = this.thinkingTokens.get(k);
          // Thinking is counted for usage but intentionally not rendered.
          this.currentTurnThinkingTokens += tokens ?? 0;
          this.thinkingBuffer.delete(k);
          this.thinkingTokens.delete(k);
        }
        return;
      }
      if (inner.type === 'message_delta') {
        const usage = inner.usage;
        if (usage) {
          for (const [k, v] of Object.entries(usage)) {
            if (typeof v === 'number') {
              this.currentTurnUsage[k] = Math.max(this.currentTurnUsage[k] ?? 0, v);
            }
          }
        }
      }
      return;
    }

    if (evt.type === 'assistant') {
      const parentId: string | undefined =
        typeof evt.parent_tool_use_id === 'string' ? evt.parent_tool_use_id : undefined;
      await this.renderer.endAssistantText(parentId);
      const msg = evt.message;
      if (msg?.model) this.currentTurnModel = msg.model;
      const blocks = msg?.content;
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b.type === 'tool_use') {
            await this.renderer.renderEvent({
              type: 'ToolUse',
              toolUseId: b.id,
              name: b.name,
              input: b.input ?? {},
              parentToolUseId: parentId,
            });
          }
        }
      }
      return;
    }

    // ── user (tool_result) ──
    if (evt.type === 'user') {
      const parentId: string | undefined =
        typeof evt.parent_tool_use_id === 'string' ? evt.parent_tool_use_id : undefined;
      const content = evt.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'tool_result') {
            const outText = normalizeToolResultContent(b.content);
            await this.renderer.renderEvent({
              type: 'ToolResult',
              toolUseId: b.tool_use_id,
              output: outText,
              isError: Boolean(b.is_error),
              parentToolUseId: parentId,
            });
          }
        }
      }
      return;
    }

    // ── rate limit ──
    if (evt.type === 'rate_limit_event') {
      const info = evt.rate_limit_info ?? {};
      if (info.status && info.status !== 'allowed') {
        await this.renderer.postRateLimit(info.status, info.resetsAt, info.rateLimitType);
      }
      return;
    }

    if (evt.type === 'api_retry' || evt.subtype === 'api_retry') {
      await this.renderer.postRetry(evt.attempt ?? 0, evt.max_retries ?? 0, evt.retry_delay_ms);
      return;
    }

    // ── result (end of turn) ──
    if (evt.type === 'result') {
      clearPromptPending(this.channelId);
      this.renderer.stopTyping();
      this.pendingReplayPrompt = null;
      this.respawnAttempts = 0;
      await this.renderer.endAssistantText();
      if (this.currentTurnTag === 'context' && !evt.is_error) {
        const contextOutput = this.capturedContextOutput ||
          (typeof evt.result === 'string' ? evt.result : '');
        await this.renderer.postContextUsage(contextOutput);
      }

      const rawDetail = evt.is_error
        ? String(evt.errors?.[0] ?? evt.subtype ?? 'unknown')
        : undefined;
      const isDiagnostic =
        typeof rawDetail === 'string' && rawDetail.includes('ede_diagnostic');
      const suppressError = this.abortRequested || isDiagnostic;

      const finalUsage: Record<string, number> = { ...this.currentTurnUsage };
      if (evt.usage && typeof evt.usage === 'object') {
        for (const [key, value] of Object.entries(evt.usage)) {
          if (typeof value === 'number') {
            finalUsage[key] = Math.max(finalUsage[key] ?? 0, value);
          }
        }
      }
      const activeThinking = [...this.thinkingTokens.values()].reduce((sum, n) => sum + n, 0);
      finalUsage.thinking_tokens = Math.max(
        finalUsage.thinking_tokens ?? 0,
        this.currentTurnThinkingTokens + activeThinking,
      );

      const turnResult: TurnResult = {
        duration_ms: evt.duration_ms,
        model: this.currentTurnModel,
        usage: finalUsage,
        is_error: suppressError ? false : evt.is_error,
        error_detail: suppressError ? undefined : rawDetail,
      };
      await this.renderer.endTurn(turnResult);

      // Completion notifications are deduplicated per accepted turn.
      const elapsed = Date.now() - this.turnStartedAt;
      if (
        !this.currentTurnIsAutomaticRecap &&
        !this.completionMentionedForTurn &&
        !this.abortRequested &&
        !turnResult.is_error
      ) {
        this.completionMentionedForTurn = true;
        const recipients = new Set<string>();
        if (this.lastPromptUserId) recipients.add(this.lastPromptUserId);
        const configured = getNotify(this.channelId);
        if (configured && elapsed > 30_000) recipients.add(configured);
        for (const userId of recipients) await this.renderer.pingUser(userId).catch(() => {});
      }

      if (!this.abortRequested && !turnResult.is_error) {
        if (this.currentTurnIsAutomaticRecap) markSessionRecapGenerated(this.channelId);
        else this.scheduleAutomaticRecap();
      }
      updateBackgroundStatus(
        this.channelId,
        this.abortRequested ? 'stopped' : turnResult.is_error ? 'error' : 'completed',
      );

      this.currentTurnUsage = {};
      this.currentTurnIsAutomaticRecap = false;
      this.currentTurnTag = null;
      this.capturedContextOutput = '';
      this.turnStartedAt = 0;
      const callbacks = this.afterTurnCallbacks.splice(0);
      for (const callback of callbacks) callback();
      return;
    }
  }
}

export function shouldScheduleAutomaticRecap(
  session: ReturnType<typeof getSession>,
  completedTurnWasAutomaticRecap: boolean,
): boolean {
  return Boolean(
    session?.recap?.enabled &&
    session.turnCount >= 3 &&
    !completedTurnWasAutomaticRecap,
  );
}

/**
 */
function normalizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (c && typeof c === 'object') {
          const rec = c as Record<string, unknown>;
          if (rec.type === 'text' && typeof rec.text === 'string') return rec.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

// Keep type export used by renderer.
void ((): TodoItem | undefined => undefined);
