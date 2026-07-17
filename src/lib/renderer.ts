import {
  TextChannel,
  ThreadChannel,
  ChannelType,
  Message,
  ContainerBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

export type SessionChannel = TextChannel | ThreadChannel;
import { Coalescer } from './throttle';
import { scrub, escapeCodeFences } from './scrubber';
import { V2_FLAGS, v2Panel } from './v2';
import { log } from './logger';
import { formatToolUse, formatToolResult } from './toolFormat';
import { applyTaskTool, finalizeTaskCreate, getTasks, replaceTodos } from './taskStore';
import { InteractionEvent } from './interactionEvents';
import { parseContextUsage } from './contextUsage';

const MSG_MAX = 1900;
const EDIT_THROTTLE_MS = 1000;

const COLOR_BRAND = 0xd77757;
const COLOR_ASSIST = 0xe879f9;
const COLOR_TOOL_RUN = 0x99aab5;
const COLOR_TOOL_OK = 0x77dd77;
const COLOR_TOOL_ERR = 0xff6961;
const COLOR_THINK = 0x9b8adf;

const BULLET = '●';
const RETURN = '⎿';
const STAR = '✻';

function formatTokens(tokens: number): string {
  const safeTokens = Math.max(0, Math.round(tokens));
  if (safeTokens < 1000) return String(safeTokens);
  return `${(safeTokens / 1000).toFixed(1)}k`;
}

type ToolMeta = {
  name: string;
  label: string;
  icon: string;
  primary: string;
  subtext?: string;
  startedAt: number;
};

const liveToolMessages = new Map<string, Message>();
const liveToolMeta = new Map<string, ToolMeta>();
const liveToolClaims = new Set<string>();
const finalizingToolKeys = new Set<string>();
const completedToolKeys = new Set<string>();
const liveTodoMessages = new Map<string, Message>();

function liveToolKey(channelId: string, toolUseId: string): string {
  return `${channelId}:${toolUseId}`;
}

function isTodoWidget(message: Message): boolean {
  return message.author.id === message.channel.client.user?.id &&
    JSON.stringify(message.components).includes('📋 Todos');
}

export async function waitForToolMessage(
  channelId: string,
  toolUseId: string,
  timeoutMs = 2_000,
): Promise<Message | null> {
  const key = liveToolKey(channelId, toolUseId);
  const deadline = Date.now() + timeoutMs;
  do {
    const message = liveToolMessages.get(key);
    if (message) return message;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return null;
}

function toolAccent(status: 'running' | 'ok' | 'err'): number {
  return status === 'running' ? COLOR_TOOL_RUN : status === 'ok' ? COLOR_TOOL_OK : COLOR_TOOL_ERR;
}

function td(text: string): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(text.slice(0, 4000));
}

function sepSmall(divider = true): SeparatorBuilder {
  return new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(divider);
}

function safe(t: string, max = 4000): string {
  const s = scrub(t);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function isUnknownMessageError(error: unknown): boolean {
  return (error as { code?: number } | null)?.code === 10008;
}

// ─────────────────────────────────────────────────────────────
// Session header
// ─────────────────────────────────────────────────────────────
export interface SessionHeaderOpts {
  model?: string;
  cwd: string;
  permissionMode: string;
  version?: string;
  sessionId?: string;
}

export function buildSessionHeader(opts: SessionHeaderOpts): ContainerBuilder {
  const c = new ContainerBuilder().setAccentColor(COLOR_BRAND);
  c.addTextDisplayComponents(td('# 🟣 Claude Code Session'));
  c.addSeparatorComponents(sepSmall(true));
  const lines: string[] = [];
  if (opts.model) lines.push(`**Model:** \`${opts.model}\``);
  lines.push(`**CWD:** \`${opts.cwd}\``);
  lines.push(`**Permission:** \`${opts.permissionMode}\``);
  if (opts.version) lines.push(`**Version:** \`${opts.version}\``);
  if (opts.sessionId) lines.push(`**Session:** \`${opts.sessionId.slice(0, 8)}\``);
  c.addTextDisplayComponents(td(lines.join('\n')));
  c.addSeparatorComponents(sepSmall(false));
  c.addTextDisplayComponents(td('-# Send a message to prompt · `/close` to archive · `/stop` to abort'));
  return c;
}

// ─────────────────────────────────────────────────────────────
// Renderer
// ─────────────────────────────────────────────────────────────
export class Renderer {
  private channel: SessionChannel;

  // Assistant streaming state (root scope)
  private assistantBuffer = '';
  private assistantMsg: Message | null = null;
  private assistantSequence = 0;
  private editCoalescer: Coalescer;

  // Tool state
  private toolMessages = new Map<string, Message>();
  private toolMeta = new Map<string, ToolMeta>();
  private toolNamePreReg = new Map<string, string>();
  private seenToolUseIds = new Set<string>();

  private todoMsg: Message | null = null;
  private retryMsg: Message | null = null;
  private rateLimitMsg: Message | null = null;
  private backgroundTaskMessages = new Map<string, Message>();
  private recentThinking = new Map<string, number>();

  private thinkingFullById = new Map<string, string>();

  /**
   * Subagent thread state.
   */
  private taskThreads = new Map<
    string,
    {
      thread: ThreadChannel | null;
      controlMsg: Message | null;
      todoMsg: Message | null;
      subagentType: string;
      description: string;
      startedAt: number;
      toolCount: number;
      assistantBuffer: string;
      assistantMsg: Message | null;
      assistantSequence: number;
      editCoalescer: Coalescer;
      done: boolean;
    }
  >();

  getCurrentTool(): string | null {
    const current = [...this.toolMeta.values()].at(-1);
    return current ? `${current.name}: ${current.primary}` : null;
  }

  async renderEvent(event: InteractionEvent): Promise<void> {
    switch (event.type) {
      case 'UserPrompt':
        await this.echoUserPrompt(event.text, 0, event.source === 'cli-local' ? 0x5865f2 : undefined, event.source === 'cli-local' ? 'CLI local' : undefined);
        return;
      case 'AssistantTextDelta':
        await this.appendAssistantText(event.text, event.parentToolUseId);
        return;
      case 'AssistantTextEnd':
        await this.endAssistantText(event.parentToolUseId);
        return;
      case 'ToolUse':
      case 'ToolRunningStatus':
        await this.onToolUse(event.toolUseId, event.name, event.input, 'parentToolUseId' in event ? event.parentToolUseId : undefined);
        return;
      case 'ToolResult':
        await this.onToolResult(event.toolUseId, event.output, event.isError, event.parentToolUseId);
        return;
      case 'TaskListUpdate':
        await this.onToolUse(event.toolUseId, event.name, event.input);
        return;
      case 'ErrorEvent':
        await this.postSystemNotice(event.title, event.detail, true);
        return;
      case 'WarningEvent':
        await this.postSystemNotice(event.title, event.detail, true);
    }
  }

  /**
   */
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  private typingDeadline = 0;
  private static readonly TYPING_RENEW_MS = 8_000;
  private static readonly TYPING_MAX_STALE_MS = 20_000;

  constructor(channel: SessionChannel) {
    this.channel = channel;
    this.editCoalescer = new Coalescer(EDIT_THROTTLE_MS, () => this.flushRootAssistantEdit());
  }

  getChannel(): SessionChannel {
    return this.channel;
  }

  /**
   * Start and periodically renew Discord typing until the stale deadline.
   */
  startTyping(): void {
    this.bumpTyping();
    if (this.typingTimer) return;
    void this.channel.sendTyping().catch(() => {});
    this.typingTimer = setInterval(() => {
      if (Date.now() > this.typingDeadline) {
        this.stopTyping();
        return;
      }
      void this.channel.sendTyping().catch(() => {});
    }, Renderer.TYPING_RENEW_MS);
  }

  bumpTyping(): void {
    this.typingDeadline = Date.now() + Renderer.TYPING_MAX_STALE_MS;
  }

  stopTyping(): void {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
    this.typingDeadline = 0;
  }

  cacheThinking(id: string, full: string): void {
    this.thinkingFullById.set(id, full);
  }

  getThinking(id: string): string | undefined {
    return this.thinkingFullById.get(id);
  }

  // ────── Resolve output scope from parent_tool_use_id ──────

  /**
   */
  private sendTargetFor(parentToolUseId?: string): SessionChannel {
    if (parentToolUseId) {
      const t = this.taskThreads.get(parentToolUseId);
      if (t?.thread) return t.thread;
    }
    return this.channel;
  }

  // ────── Session-level ──────

  async postSessionHeader(opts: SessionHeaderOpts): Promise<void> {
    try {
      await this.channel.send({
        components: [buildSessionHeader(opts)],
        flags: V2_FLAGS,
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      log.warn('postSessionHeader failed:', err instanceof Error ? err.message : err);
    }
  }

  // ────── Turn-level ──────

  startTurn(): void {
    this.assistantBuffer = '';
    this.assistantMsg = null;
    this.assistantSequence = 0;
  }

  async echoUserPrompt(
    text: string,
    imageCount = 0,
    accentColor?: number,
    tag?: string,
  ): Promise<void> {
    const c = new ContainerBuilder().setAccentColor(accentColor ?? COLOR_ASSIST);
    const imgTag =
      imageCount > 0
        ? `\n-# 📎 ${imageCount} inline image(s), attached to this turn as base64`
        : '';
    const prefix = tag ? `-# ${tag}\n` : '';
    c.addTextDisplayComponents(td(`${prefix}> ${safe(text, 3800)}${imgTag}`));
    try {
      await this.channel.send({
        components: [c],
        flags: V2_FLAGS,
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      log.warn('echoUserPrompt failed:', err instanceof Error ? err.message : err);
    }
  }

  // ────── Assistant text streaming ──────

  /**
   */
  async appendAssistantText(delta: string, parentToolUseId?: string): Promise<void> {
    if (!delta) return;

    const task = parentToolUseId ? this.taskThreads.get(parentToolUseId) : undefined;
    if (task) {
      await this.appendTaskAssistantText(task, delta);
      return;
    }

    let remaining = delta;
    while (remaining.length > 0) {
      const room = MSG_MAX - this.assistantBuffer.length;
      if (remaining.length <= room) {
        this.assistantBuffer += remaining;
        remaining = '';
        this.editCoalescer.schedule();
      } else {
        const fit = remaining.slice(0, room);
        remaining = remaining.slice(room);
        this.assistantBuffer += fit;
        await this.editCoalescer.flush();
        this.assistantBuffer = '';
        this.assistantMsg = null;
        this.assistantSequence++;
      }
    }
  }

  private async flushRootAssistantEdit(): Promise<void> {
    if (!this.assistantBuffer.trim()) return;
    const body = scrub(this.assistantBuffer);
    const prefix = this.assistantSequence === 0 ? `${BULLET} ` : `${BULLET} _(part ${this.assistantSequence + 1})_ `;
    const content = prefix + body;

    try {
      if (!this.assistantMsg) {
        this.assistantMsg = await this.channel.send({
          content,
          allowedMentions: { parse: [] },
        });
      } else {
        await this.assistantMsg.edit({
          content,
          allowedMentions: { parse: [] },
        });
      }
    } catch (err) {
      log.warn('assistant edit failed:', err instanceof Error ? err.message : err);
      // Keep identity across transient Discord failures. Only create a new
      // message when Discord confirms that the original was deleted.
      if (isUnknownMessageError(err)) this.assistantMsg = null;
    }
  }

  private async appendTaskAssistantText(
    task: NonNullable<ReturnType<Map<string, {
      thread: ThreadChannel | null;
      controlMsg: Message | null;
      todoMsg: Message | null;
      subagentType: string;
      description: string;
      startedAt: number;
      toolCount: number;
      assistantBuffer: string;
      assistantMsg: Message | null;
      assistantSequence: number;
      editCoalescer: Coalescer;
      done: boolean;
    }>['get']>>,
    delta: string,
  ): Promise<void> {
    let remaining = delta;
    while (remaining.length > 0) {
      const room = MSG_MAX - task.assistantBuffer.length;
      if (remaining.length <= room) {
        task.assistantBuffer += remaining;
        remaining = '';
        task.editCoalescer.schedule();
      } else {
        const fit = remaining.slice(0, room);
        remaining = remaining.slice(room);
        task.assistantBuffer += fit;
        await task.editCoalescer.flush();
        task.assistantBuffer = '';
        task.assistantMsg = null;
        task.assistantSequence++;
      }
    }
  }

  private async flushTaskAssistantEdit(taskId: string): Promise<void> {
    const task = this.taskThreads.get(taskId);
    if (!task || !task.thread) return;
    if (!task.assistantBuffer.trim()) return;
    const body = scrub(task.assistantBuffer);
    const prefix = task.assistantSequence === 0 ? `${BULLET} ` : `${BULLET} _(part ${task.assistantSequence + 1})_ `;
    const content = prefix + body;
    try {
      if (!task.assistantMsg) {
        task.assistantMsg = await task.thread.send({
          content,
          allowedMentions: { parse: [] },
        });
      } else {
        await task.assistantMsg.edit({
          content,
          allowedMentions: { parse: [] },
        });
      }
    } catch (err) {
      log.warn('task assistant edit failed:', err instanceof Error ? err.message : err);
      if (isUnknownMessageError(err)) task.assistantMsg = null;
    }
  }

  async endAssistantText(parentToolUseId?: string): Promise<void> {
    if (parentToolUseId) {
      const task = this.taskThreads.get(parentToolUseId);
      if (task) {
        await task.editCoalescer.flush();
        return;
      }
    }
    await this.editCoalescer.flush();
  }

  // ────── Tool use ──────

  /**
   * Covers an event race or a CLI restart during a turn.
   */
  preRegisterTool(toolUseId: string, name: string, _parentToolUseId?: string): void {
    if (!name) return;
    this.toolNamePreReg.set(toolUseId, name);
  }

  async onToolUse(
    toolUseId: string,
    name: string,
    input: Record<string, unknown>,
    parentToolUseId?: string,
  ): Promise<void> {
    // `assistant` and forwarded subagent streams may repeat the same block.
    // A tool_use_id owns exactly one Discord card for its entire lifecycle.
    if (this.seenToolUseIds.has(toolUseId)) return;
    this.seenToolUseIds.add(toolUseId);
    if (this.seenToolUseIds.size > 2000) {
      this.seenToolUseIds = new Set([...this.seenToolUseIds].slice(-1000));
    }
    await this.endAssistantText(parentToolUseId);

    if (name === 'TodoWrite') {
      const todos = Array.isArray(input?.todos) ? (input.todos as TodoItem[]) : [];
      replaceTodos(this.channel.id, todos);
      await this.renderTodo(todos, parentToolUseId);
      return;
    }

    if (name === 'TaskCreate' || name === 'TaskUpdate') {
      applyTaskTool(this.channel.id, name, input, toolUseId);
      await this.renderTodo(getTasks(this.channel.id), parentToolUseId);
    }

    // Task/Agent tools receive a dedicated subagent thread.
    if (name === 'Task' || name === 'Agent') {
      const subagentType =
        typeof input.subagent_type === 'string' ? input.subagent_type : 'agent';
      const description =
        typeof input.description === 'string' ? input.description : '';
      await this.beginTask(toolUseId, subagentType, description);
      return;
    }

    const sharedKey = liveToolKey(this.channel.id, toolUseId);
    // Runner stdout and the JSONL tail can briefly observe the same tool. The
    // synchronous claim closes the send/await race between two Renderer
    // instances and guarantees one card per tool_use_id.
    if (liveToolClaims.has(sharedKey) || liveToolMessages.has(sharedKey)) return;
    liveToolClaims.add(sharedKey);

    const target = this.sendTargetFor(parentToolUseId);
    const fmt = formatToolUse(name, input);

    if (parentToolUseId) {
      const t = this.taskThreads.get(parentToolUseId);
      if (t) t.toolCount++;
    }

    const metadata: ToolMeta = {
      name,
      label: fmt.label,
      icon: fmt.icon,
      primary: fmt.primary,
      subtext: fmt.subtext,
      startedAt: Date.now(),
    };
    this.toolMeta.set(toolUseId, metadata);
    liveToolMeta.set(sharedKey, metadata);

    const c = new ContainerBuilder().setAccentColor(toolAccent('running'));
    c.addTextDisplayComponents(
      td(`${BULLET} ${fmt.icon} **${fmt.label}** \`${safe(fmt.primary, 400)}\``),
    );
    c.addTextDisplayComponents(td(`  ${RETURN} _Running…_`));
    if (fmt.subtext) {
      c.addTextDisplayComponents(td(`-# ${safe(fmt.subtext, 300)}`));
    }

    // `vscode://` — Discord.js reject non-http(s)/discord URL protocol.
    if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') {
      const path =
        (input as Record<string, unknown>).file_path ??
        (input as Record<string, unknown>).notebook_path;
      if (typeof path === 'string' && path.startsWith('/')) {
        c.addTextDisplayComponents(td(`-# 📂 \`${safe(path, 300)}\``));
      }
    }

    try {
      const msg = await target.send({
        components: [c],
        flags: V2_FLAGS,
        allowedMentions: { parse: [] },
      });
      this.toolMessages.set(toolUseId, msg);
      liveToolMessages.set(liveToolKey(this.channel.id, toolUseId), msg);
    } catch (err) {
      liveToolClaims.delete(sharedKey);
      liveToolMeta.delete(sharedKey);
      log.warn('onToolUse failed:', err instanceof Error ? err.message : err);
    }

    if (parentToolUseId) {
      const t = this.taskThreads.get(parentToolUseId);
      if (t) {
        t.assistantBuffer = '';
        t.assistantMsg = null;
        t.assistantSequence = 0;
      }
    } else {
      this.assistantBuffer = '';
      this.assistantMsg = null;
      this.assistantSequence = 0;
    }
  }

  async onToolResult(
    toolUseId: string,
    output: string,
    isError: boolean,
    parentToolUseId?: string,
  ): Promise<void> {
    // Task subagent complete → close thread + delete.
    if (this.taskThreads.has(toolUseId)) {
      await this.endTask(toolUseId, output, isError);
      return;
    }

    const sharedKey = liveToolKey(this.channel.id, toolUseId);
    if (completedToolKeys.has(sharedKey) || finalizingToolKeys.has(sharedKey)) return;
    finalizingToolKeys.add(sharedKey);

    let meta = this.toolMeta.get(toolUseId) ?? liveToolMeta.get(sharedKey);
    const msg = this.toolMessages.get(toolUseId)
      ?? liveToolMessages.get(sharedKey)
      ?? await waitForToolMessage(this.channel.id, toolUseId);
    // The result stream can arrive before the aggregate assistant tool_use
    // event. `waitForToolMessage` closes that race for the Discord card, but
    // the matching metadata may have been registered during the same wait.
    // Refresh it so the completed card keeps paths, commands, and subtext.
    meta ??= this.toolMeta.get(toolUseId) ?? liveToolMeta.get(sharedKey);
    const duration = meta ? Date.now() - meta.startedAt : undefined;
    const target = this.sendTargetFor(parentToolUseId);

    const fallbackName = this.toolNamePreReg.get(toolUseId);
    const fallbackFmt = !meta && fallbackName ? formatToolUse(fallbackName, {}) : undefined;
    const nameForResult = meta?.name ?? fallbackName ?? 'Tool';
    const labelForResult = meta?.label ?? fallbackFmt?.label ?? 'Tool';
    const iconForResult = meta?.icon ?? fallbackFmt?.icon ?? '🔧';

    const fmt = formatToolResult(nameForResult, output, isError, duration);
    if (nameForResult === 'TaskCreate' && !isError) {
      finalizeTaskCreate(this.channel.id, toolUseId, output);
      await this.renderTodo(getTasks(this.channel.id), parentToolUseId);
    }

    const c = new ContainerBuilder().setAccentColor(toolAccent(isError ? 'err' : 'ok'));
    c.addTextDisplayComponents(
      td(
        `${BULLET} ${iconForResult} **${labelForResult}** \`${safe(meta?.primary ?? '', 400)}\``,
      ),
    );

    if (fmt.body) {
      const codeLang = '';
      const bodyStr = escapeCodeFences(safe(fmt.body, 1600));
      c.addTextDisplayComponents(td(`  ${RETURN} \`\`\`${codeLang}\n${bodyStr}\n\`\`\``));
    } else {
      c.addTextDisplayComponents(td(`  ${RETURN} ${fmt.summary}`));
    }

    const foots: string[] = [];
    foots.push(fmt.summary);
    if (duration != null) foots.push(`${duration}ms`);
    if (fmt.truncated && fmt.totalBytes != null) foots.push(`${fmt.totalBytes} bytes total`);
    c.addTextDisplayComponents(td(`-# ${foots.join(' · ')}`));

    if (meta?.subtext) {
      c.addTextDisplayComponents(td(`-# ${safe(meta.subtext, 300)}`));
    }

    try {
      if (msg) {
        await msg.edit({
          components: [c],
          flags: V2_FLAGS,
          allowedMentions: { parse: [] },
        } as unknown as Parameters<Message['edit']>[0]);
      } else {
        await target.send({
          components: [c],
          flags: V2_FLAGS,
          allowedMentions: { parse: [] },
        });
      }
    } catch (err) {
      log.warn('onToolResult failed:', err instanceof Error ? err.message : err);
    }

    finalizingToolKeys.delete(sharedKey);
    completedToolKeys.add(sharedKey);
    if (completedToolKeys.size > 4000) {
      for (const key of [...completedToolKeys].slice(0, 2000)) completedToolKeys.delete(key);
    }
    this.toolMessages.delete(toolUseId);
    liveToolMessages.delete(sharedKey);
    liveToolMeta.delete(sharedKey);
    liveToolClaims.delete(sharedKey);
    this.toolMeta.delete(toolUseId);
    this.toolNamePreReg.delete(toolUseId);
  }

  // ────── Todo widget ──────

  async renderTodo(todos: TodoItem[], parentToolUseId?: string): Promise<void> {
    if (!parentToolUseId && !this.todoMsg) {
      this.todoMsg = liveTodoMessages.get(this.channel.id) ?? null;
      if (!this.todoMsg) {
        const recent = await this.channel.messages.fetch({ limit: 50 }).catch(() => null);
        const widgets = recent
          ? [...recent.values()].filter(isTodoWidget).sort((a, b) => b.createdTimestamp - a.createdTimestamp)
          : [];
        this.todoMsg = widgets[0] ?? null;
        if (this.todoMsg) liveTodoMessages.set(this.channel.id, this.todoMsg);
        for (const duplicate of widgets.slice(1)) {
          await duplicate.unpin().catch(() => {});
          await duplicate.delete().catch(() => {});
        }
      }
    }

    if (todos.length === 0) {
      if (!parentToolUseId) {
        const staleWidgets: Message[] = this.todoMsg ? [this.todoMsg] : [];
        this.todoMsg = null;
        liveTodoMessages.delete(this.channel.id);
        if (staleWidgets.length === 0) {
          const pinned = await this.channel.messages.fetchPinned().catch(() => null);
          if (pinned) {
            for (const message of pinned.values()) {
              if (
                isTodoWidget(message)
              ) staleWidgets.push(message);
            }
          }
        }
        for (const stale of staleWidgets) {
          await stale.unpin().catch(() => {});
          await stale.delete().catch((err) => {
            log.warn('delete empty todo widget failed:', err instanceof Error ? err.message : err);
          });
        }
      }
      return;
    }

    const c = new ContainerBuilder().setAccentColor(COLOR_ASSIST);
    c.addTextDisplayComponents(td('## 📋 Todos'));
    c.addSeparatorComponents(sepSmall(true));
    const lines = todos.map((t) => {
      const icon =
        t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '⏳' : '☐';
      const content = safe(t.content || '', 200);
      if (t.status === 'completed') return `${icon} ~~${content}~~`;
      if (t.status === 'in_progress') return `${icon} **${content}**`;
      return `${icon} ${content}`;
    });
    c.addTextDisplayComponents(td(lines.join('\n').slice(0, 3800)));

    if (parentToolUseId && this.taskThreads.has(parentToolUseId)) {
      const target = this.sendTargetFor(parentToolUseId);
      const task = this.taskThreads.get(parentToolUseId)!;
      try {
        const payload = { components: [c], flags: V2_FLAGS, allowedMentions: { parse: [] as never[] } };
        if (task.todoMsg) {
          await task.todoMsg.edit(payload as unknown as Parameters<Message['edit']>[0]);
        } else {
          task.todoMsg = await target.send(payload as unknown as Parameters<typeof target.send>[0]);
        }
      } catch (err) {
        log.warn('renderTodo (task) failed:', err instanceof Error ? err.message : err);
      }
      return;
    }

    try {
      if (this.todoMsg) {
        if (this.todoMsg.pinned) await this.todoMsg.unpin().catch(() => {});
        await this.todoMsg.edit({
          components: [c],
          flags: V2_FLAGS,
          allowedMentions: { parse: [] },
        } as unknown as Parameters<Message['edit']>[0]);
      } else {
        this.todoMsg = await this.channel.send({
          components: [c],
          flags: V2_FLAGS,
          allowedMentions: { parse: [] },
        });
        liveTodoMessages.set(this.channel.id, this.todoMsg);
      }
    } catch (err) {
      log.warn('renderTodo failed:', err instanceof Error ? err.message : err);
      if ((err as { code?: number }).code === 10008) {
        this.todoMsg = null;
        liveTodoMessages.delete(this.channel.id);
      }
    }
  }

  // ────── Thinking ──────

  async onThinking(preview: string, tokens?: number, parentToolUseId?: string): Promise<void> {
    const normalized = preview.trim().replace(/\s+/g, ' ');
    const dedupeKey = `${parentToolUseId ?? 'root'}:${normalized}`;
    const now = Date.now();
    const previous = this.recentThinking.get(dedupeKey) ?? 0;
    if (now - previous < 30_000) return;
    this.recentThinking.set(dedupeKey, now);
    if (this.recentThinking.size > 100) {
      for (const [key, seenAt] of this.recentThinking) {
        if (now - seenAt >= 30_000) this.recentThinking.delete(key);
      }
    }
    await this.endAssistantText(parentToolUseId);
    const target = this.sendTargetFor(parentToolUseId);
    const c = new ContainerBuilder().setAccentColor(COLOR_THINK);
    const head = tokens != null ? `${STAR} Thinking (${tokens} tokens)` : `${STAR} Thinking`;
    const previewLine = preview
      ? `> ${safe(preview.replace(/\n/g, ' ').slice(0, 300), 300)}${preview.length > 300 ? '…' : ''}`
      : '';
    c.addTextDisplayComponents(td(`-# ${head}\n-# ${previewLine}`));

    const id = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.cacheThinking(id, preview);
    if (preview.length > 300) {
      c.addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Secondary)
            .setLabel('Expand thinking')
            .setCustomId(`cr:think:${id}`),
        ),
      );
    }

    try {
      await target.send({
        components: [c],
        flags: V2_FLAGS,
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      log.warn('onThinking failed:', err instanceof Error ? err.message : err);
    }
  }

  // ────── Turn end panel ──────

  async endTurn(result: TurnResult): Promise<void> {
    await this.editCoalescer.flush();

    const foots: string[] = [];
    if (result.duration_ms != null) foots.push(`${(result.duration_ms / 1000).toFixed(1)}s`);
    if (result.usage) {
      const u = result.usage;
      const inTok =
        (u.input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0);
      const outTok = u.output_tokens ?? 0;
      foots.push(`${formatTokens(inTok)} in · ${formatTokens(outTok)} out`);
      if ((u.thinking_tokens ?? 0) > 0) {
        foots.push(`${formatTokens(u.thinking_tokens ?? 0)} think`);
      }
    }
    if (result.model) foots.push(`\`${result.model}\``);

    const line = `${RETURN} Cooked · ${foots.join(' · ')}`;

    if (this.assistantMsg && this.assistantBuffer) {
      const body = scrub(this.assistantBuffer);
      const prefix = this.assistantSequence === 0 ? `${BULLET} ` : `${BULLET} _(part ${this.assistantSequence + 1})_ `;
      const suffix = `\n-# ${line}`;
      const bodyRoom = Math.max(0, MSG_MAX - prefix.length - suffix.length);
      const visibleBody = body.length > bodyRoom
        ? `${body.slice(0, Math.max(0, bodyRoom - 1))}…`
        : body;
      const newContent = `${prefix}${visibleBody}${suffix}`;
      try {
        await this.assistantMsg.edit({
          content: newContent,
          allowedMentions: { parse: [] },
        });
        return;
      } catch (err) {
        log.warn('endTurn edit assistant failed, fallback to new message:', err instanceof Error ? err.message : err);
      }
    }

    try {
      await this.channel.send({
        content: `-# ${line}`,
        allowedMentions: { parse: [] },
      });
    } catch {
      /* ignore */
    }

    if (result.is_error && result.error_detail) {
      const c = new ContainerBuilder().setAccentColor(COLOR_TOOL_ERR);
      c.addTextDisplayComponents(td(`## ❌ Turn error`));
      c.addTextDisplayComponents(td(safe(result.error_detail, 3000)));
      try {
        await this.channel.send({
          components: [c],
          flags: V2_FLAGS,
          allowedMentions: { parse: [] },
        });
      } catch {
        /* ignore */
      }
    }
  }

  // ────── System banners ──────

  async postRateLimit(status: string, resetsAt?: number, rateLimitType?: string): Promise<void> {
    const c = new ContainerBuilder().setAccentColor(0xffc107);
    const resetTxt = resetsAt ? ` · resets <t:${Math.floor(resetsAt / 1000)}:R>` : '';
    c.addTextDisplayComponents(
      td(`## ⚠ Rate limit — ${status}${rateLimitType ? ` (${rateLimitType})` : ''}${resetTxt}`),
    );
    const payload = { components: [c], flags: V2_FLAGS, allowedMentions: { parse: [] as never[] } };
    try {
      if (this.rateLimitMsg) {
        await this.rateLimitMsg.edit(payload as unknown as Parameters<Message['edit']>[0]);
      } else {
        this.rateLimitMsg = await this.channel.send(payload as unknown as Parameters<typeof this.channel.send>[0]);
      }
    } catch (error) {
      if (isUnknownMessageError(error)) this.rateLimitMsg = null;
    }
  }

  async postRetry(attempt: number, maxAttempts: number, delayMs?: number): Promise<void> {
    const nextIn = delayMs ? ` · next in ${(delayMs / 1000).toFixed(1)}s` : '';
    const payload = {
      content: `-# ↻ Retrying (${attempt}/${maxAttempts})${nextIn}`,
      allowedMentions: { parse: [] as never[] },
    };
    try {
      if (this.retryMsg) await this.retryMsg.edit(payload);
      else this.retryMsg = await this.channel.send(payload);
    } catch (error) {
      if (isUnknownMessageError(error)) this.retryMsg = null;
    }
  }

  async postBackgroundTaskStatus(
    taskId: string,
    title: string,
    detail: string,
    status: 'running' | 'completed' | 'error' = 'running',
  ): Promise<void> {
    const key = taskId || 'background-task';
    const c = new ContainerBuilder().setAccentColor(
      status === 'error' ? COLOR_TOOL_ERR : status === 'completed' ? COLOR_TOOL_OK : COLOR_TOOL_RUN,
    );
    const icon = status === 'error' ? '❌' : status === 'completed' ? '✅' : 'ℹ️';
    c.addTextDisplayComponents(td(`## ${icon} ${safe(title, 180)}`));
    if (detail.trim()) c.addTextDisplayComponents(td(safe(detail, 3000)));
    const payload = { components: [c], flags: V2_FLAGS, allowedMentions: { parse: [] as never[] } };
    const current = this.backgroundTaskMessages.get(key);
    try {
      if (current) {
        await current.edit(payload as unknown as Parameters<Message['edit']>[0]);
      } else {
        const message = await this.channel.send(payload as unknown as Parameters<typeof this.channel.send>[0]);
        this.backgroundTaskMessages.set(key, message);
      }
    } catch (err) {
      log.warn('postBackgroundTaskStatus failed:', err instanceof Error ? err.message : err);
      if (isUnknownMessageError(err)) this.backgroundTaskMessages.delete(key);
    }
  }

  async postSystemNotice(title: string, detail?: string, warning = false): Promise<void> {
    const c = new ContainerBuilder().setAccentColor(warning ? 0xffc107 : COLOR_TOOL_RUN);
    c.addTextDisplayComponents(td(`## ${warning ? '⚠️' : 'ℹ️'} ${safe(title, 180)}`));
    if (detail?.trim()) c.addTextDisplayComponents(td(safe(detail, 3000)));
    await this.channel.send({ components: [c], flags: V2_FLAGS, allowedMentions: { parse: [] } }).catch(() => {});
  }

  async postContextUsage(raw: string): Promise<void> {
    const usage = parseContextUsage(raw);
    if (!usage) {
      await this.postSystemNotice(
        'Context usage',
        raw.trim() || 'Claude Code returned no context breakdown.',
        true,
      );
      return;
    }
    const panel = v2Panel({
      title: 'Context Usage',
      body:
        `\`${usage.grid}\`\n` +
        `⛀⛁ **Skills:** ${formatTokens(usage.skillsTokens)} tokens (${usage.skillsPercent.toFixed(1)}%)\n` +
        `⛂⛃ **Context:** ${formatTokens(usage.contextTokens)} tokens (${usage.contextPercent.toFixed(1)}%)\n` +
        `⛶ **Free space:** ${formatTokens(usage.freeTokens)} tokens (${usage.freePercent.toFixed(1)}%)`,
      fields: [
        { label: 'Used', value: `${formatTokens(usage.usedTokens)} / ${formatTokens(usage.maxTokens)} (${usage.usedPercent.toFixed(1)}%)` },
        ...(usage.model ? [{ label: 'Model', value: usage.model }] : []),
      ],
      footer: '⛀⛁ skills · ⛂⛃ context · ⛶ free space',
      accent: COLOR_BRAND,
    });
    await this.channel.send({
      components: [panel],
      flags: V2_FLAGS,
      allowedMentions: { parse: [] },
    }).catch(() => {});
  }

  async postCompactBoundary(pre?: number, post?: number, trigger?: string): Promise<void> {
    const parts = ['— context compacted'];
    if (trigger) parts.push(trigger);
    if (pre != null && post != null) parts.push(`${(pre / 1000).toFixed(1)}k → ${(post / 1000).toFixed(1)}k tokens`);
    await this.channel
      .send({
        content: `-# ${parts.join(' · ')}`,
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }

  async postTaskStarted(taskId: string, subagentType: string, description: string): Promise<void> {
    await this.postBackgroundTaskStatus(
      taskId,
      `Background task — ${subagentType}`,
      description,
      'running',
    );
  }

  /**
   * Create a child thread for a Task tool use.
   */
  async beginTask(parentId: string, subagentType: string, description: string): Promise<void> {
    // Nested tasks still resolve to the root text channel.
    let base: TextChannel | null = null;
    if (this.channel.type === ChannelType.GuildText) {
      base = this.channel as TextChannel;
    } else if ('parent' in this.channel && this.channel.parent?.type === ChannelType.GuildText) {
      base = this.channel.parent as TextChannel;
    }
    if (!base) {
      log.warn('beginTask: could not resolve a base text channel for the thread');
      return;
    }

    // Keep thread names compact and within Discord's limit.
    const shortDesc = safe(description, 60).replace(/\n/g, ' ').trim() || 'task';
    const rawName = `🤖 ${subagentType} · ${shortDesc}`;
    const threadName = rawName.slice(0, 90);

    let thread: ThreadChannel | null = null;
    let controlMsg: Message | null = null;
    try {
      thread = await base.threads.create({
        name: threadName,
        autoArchiveDuration: 60,
        type: ChannelType.PublicThread,
        reason: 'clauderemote subagent',
      });
    } catch (err) {
      log.warn('beginTask create thread failed:', err instanceof Error ? err.message : err);
    }

    try {
      if (thread) {
        controlMsg = await base.send({
          content: `-# ${BULLET} 🤖 **Task**(${subagentType}) → <#${thread.id}> · ${safe(description, 200)}`,
          allowedMentions: { parse: [] },
        });
      } else {
        controlMsg = await base.send({
          content: `-# ${BULLET} 🤖 **Task**(${subagentType}) · ${safe(description, 200)} — (thread creation failed, running inline)`,
          allowedMentions: { parse: [] },
        });
      }
    } catch {
      /* ignore */
    }

    // Post the subagent header inside the thread.
    if (thread) {
      const c = new ContainerBuilder().setAccentColor(COLOR_THINK);
      c.addTextDisplayComponents(
        td(`${BULLET} 🤖 **Task**(${subagentType})`),
      );
      c.addTextDisplayComponents(td(safe(description, 3800)));
      c.addSeparatorComponents(sepSmall(false));
      c.addTextDisplayComponents(td('-# Subagent thread — automatically removed when the task finishes'));
      await thread
        .send({
          components: [c],
          flags: V2_FLAGS,
          allowedMentions: { parse: [] },
        })
        .catch(() => {});
    }

    const task: NonNullable<ReturnType<typeof this.taskThreads.get>> = {
      thread,
      controlMsg,
      todoMsg: null,
      subagentType,
      description,
      startedAt: Date.now(),
      toolCount: 0,
      assistantBuffer: '',
      assistantMsg: null,
      assistantSequence: 0,
      editCoalescer: new Coalescer(EDIT_THROTTLE_MS, () => this.flushTaskAssistantEdit(parentId)),
      done: false,
    };
    this.taskThreads.set(parentId, task);
  }

  async refreshTask(_parentId: string): Promise<void> {
    void _parentId;
  }

  /**
   */
  async endTask(parentId: string, output: string, isError: boolean): Promise<void> {
    const t = this.taskThreads.get(parentId);
    if (!t) return;
    t.done = true;
    await t.editCoalescer.flush().catch(() => {});
    t.editCoalescer.cancel();

    const duration = Date.now() - t.startedAt;
    const summary = isError
      ? `Failed after ${t.toolCount} step${t.toolCount === 1 ? '' : 's'} · ${(duration / 1000).toFixed(1)}s`
      : `Complete · ${t.toolCount} step${t.toolCount === 1 ? '' : 's'} · ${(duration / 1000).toFixed(1)}s`;

    let base: TextChannel | null = null;
    if (this.channel.type === ChannelType.GuildText) {
      base = this.channel as TextChannel;
    } else if ('parent' in this.channel && this.channel.parent?.type === ChannelType.GuildText) {
      base = this.channel.parent as TextChannel;
    }

    if (base) {
      const previewLines = output.split('\n').slice(0, 3).join('\n');
      const preview = previewLines ? escapeCodeFences(safe(previewLines, 500)) : '';
      const c = new ContainerBuilder().setAccentColor(
        isError ? COLOR_TOOL_ERR : COLOR_TOOL_OK,
      );
      c.addTextDisplayComponents(
        td(`${BULLET} 🤖 **Task**(${t.subagentType}) · ${safe(t.description, 200)}`),
      );
      if (preview) {
        c.addTextDisplayComponents(td(`  ${RETURN} \`\`\`\n${preview}\n\`\`\``));
      }
      c.addTextDisplayComponents(td(`-# ${summary}`));
      const payload = { components: [c], flags: V2_FLAGS, allowedMentions: { parse: [] as never[] } };
      if (t.controlMsg) {
        await t.controlMsg.edit(payload as unknown as Parameters<Message['edit']>[0]).catch(() => {});
      } else {
        await base.send(payload as unknown as Parameters<typeof base.send>[0]).catch(() => {});
      }
    }

    if (t.thread) {
      await t.thread.delete('clauderemote subagent finished').catch((err: Error) => {
        log.warn('endTask delete thread failed:', err.message);
      });
    }
    this.taskThreads.delete(parentId);
  }

  async postPermissionDenied(toolName: string, reason: string): Promise<void> {
    const c = new ContainerBuilder().setAccentColor(COLOR_TOOL_ERR);
    c.addTextDisplayComponents(td(`## 🚫 Permission denied: **${toolName}**`));
    c.addTextDisplayComponents(td(`> ${safe(reason || '(no reason)', 1000)}`));
    await this.channel
      .send({ components: [c], flags: V2_FLAGS, allowedMentions: { parse: [] } })
      .catch(() => {});
  }

  async postSystem(text: string): Promise<void> {
    await this.channel
      .send({
        content: `-# ${safe(text, 1800)}`,
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }

  async postError(text: string): Promise<void> {
    const c = new ContainerBuilder().setAccentColor(COLOR_TOOL_ERR);
    c.addTextDisplayComponents(td(`## ❌ Error\n${safe(text, 3800)}`));
    await this.channel
      .send({ components: [c], flags: V2_FLAGS, allowedMentions: { parse: [] } })
      .catch(() => {});
  }

  async pingUser(userId: string): Promise<void> {
    await this.channel
      .send({
        content: `-# ⏱ Turn complete — <@${userId}>`,
        allowedMentions: { users: [userId] },
      })
      .catch(() => {});
  }

  async dmUser(userId: string, title: string, message: string): Promise<void> {
    try {
      const user = await this.channel.client.users.fetch(userId);
      await user.send({
        components: [new ContainerBuilder()
          .setAccentColor(COLOR_BRAND)
          .addTextDisplayComponents(td(`## 🔔 ${safe(title || 'Claude Code', 120)}\n${safe(message, 3500)}`))],
        flags: V2_FLAGS,
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      log.warn('dmUser failed:', err instanceof Error ? err.message : err);
    }
  }

  cancel(): void {
    this.editCoalescer.cancel();
    for (const t of this.taskThreads.values()) {
      t.editCoalescer.cancel();
    }
    this.stopTyping();
  }
}

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface TurnResult {
  duration_ms?: number;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    thinking_tokens?: number;
  };
  is_error?: boolean;
  error_detail?: string;
}
