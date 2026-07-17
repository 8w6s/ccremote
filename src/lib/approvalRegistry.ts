import { Client, TextChannel, ThreadChannel, ChannelType, Message } from 'discord.js';
import type {
  ApprovalDecision,
  ApprovalRequestArgs,
} from './approvalMcpServer';
import {
  renderBashApproval,
  renderQuestionApproval,
  renderPlanApproval,
  ApprovalQuestion,
  QuestionFormState,
  markApprovalResolved,
} from './approvalUI';
import { getSession } from './state';
import { log } from './logger';
import { waitForToolMessage } from './renderer';

/**
 * Correlates Claude MCP permission requests with Discord interactions.
 *
 * requestApproval creates a pending entry and renders its control message.
 * Discord handlers resolve the matching request exactly once.
 * → resolve Promise.
 *
 * The Discord client is injected during ready startup.
 */

interface Pending {
  requestId: string;
  channelId: string;
  args: ApprovalRequestArgs;
  message: Message | null;
  createdAt: number;
  resolve: (decision: ApprovalDecision) => void;
  timeout: ReturnType<typeof setTimeout> | null;
  target: TextChannel | ThreadChannel;
  form?: QuestionFormState;
  active: boolean;
}

const pending = new Map<string, Pending>();
const byChannel = new Map<string, Set<string>>();
const inflightByTool = new Map<string, Promise<ApprovalDecision>>();
let discordClient: Client | null = null;

const APPROVAL_TIMEOUT_MS = 5 * 60_000;

export function setDiscordClient(client: Client): void {
  discordClient = client;
}

/**
 */
export async function requestApproval(
  channelId: string,
  args: ApprovalRequestArgs,
): Promise<ApprovalDecision> {
  if (!discordClient) {
    log.warn('requestApproval: Discord client is not initialized');
    return { behavior: 'deny', message: 'Bot is not initialized' };
  }

  const ch =
    discordClient.channels.cache.get(channelId) ??
    (await discordClient.channels.fetch(channelId).catch((err) => {
      log.warn(
        `requestApproval[${channelId}] channel fetch fail:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }));
  if (
    !ch ||
    (ch.type !== ChannelType.GuildText &&
      ch.type !== ChannelType.PublicThread &&
      ch.type !== ChannelType.PrivateThread &&
      ch.type !== ChannelType.AnnouncementThread)
  ) {
    log.warn(`requestApproval[${channelId}]: channel unavailable/type unsupported`);
    return { behavior: 'deny', message: 'Channel does not exist' };
  }
  const target = ch as TextChannel | ThreadChannel;

  const requestId = args.tool_use_id ?? `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inflightKey = `${channelId}:${requestId}`;
  const duplicate = inflightByTool.get(inflightKey);
  if (duplicate) return duplicate;
  log.dim(`requestApproval[${channelId}] ${args.tool_name} id=${requestId}`);

  const decisionPromise = new Promise<ApprovalDecision>((resolve) => {
    let resolved = false;
    const wrappedResolve = (d: ApprovalDecision): void => {
      if (resolved) return;
      resolved = true;
      pending.delete(requestId);
      byChannel.get(channelId)?.delete(requestId);
      inflightByTool.delete(inflightKey);
      if (entry.timeout) clearTimeout(entry.timeout);
      resolve(d);
      void activateNext(channelId);
    };

    const entry: Pending = {
      requestId,
      channelId,
      args,
      message: null,
      createdAt: Date.now(),
      resolve: wrappedResolve,
      timeout: null,
      target,
      active: false,
    };
    if (args.tool_name === 'AskUserQuestion' && Array.isArray(args.input.questions)) {
      const questions = (args.input.questions as ApprovalQuestion[]).filter(
        (q) => q && typeof q.question === 'string' && Array.isArray(q.options),
      );
      if (questions.length > 0) {
        entry.form = {
          questions,
          current: 0,
          answers: questions.map(() => []),
          optionPages: questions.map(() => 0),
        };
      }
    }
    pending.set(requestId, entry);
    let set = byChannel.get(channelId);
    if (!set) {
      set = new Set();
      byChannel.set(channelId, set);
    }
    set.add(requestId);

    void activateNext(channelId);
  });
  inflightByTool.set(inflightKey, decisionPromise);
  return decisionPromise;
}

/** Only the queue head is visible/actionable; parallel tool approvals wait. */
async function activateNext(channelId: string): Promise<void> {
  const ids = byChannel.get(channelId);
  if (!ids) return;
  const entries = [...ids].map((id) => pending.get(id)).filter((e): e is Pending => Boolean(e));
  if (entries.some((entry) => entry.active)) return;
  const entry = entries[0];
  if (!entry) return;
  entry.active = true;
  entry.timeout = setTimeout(() => {
    void markApprovalResolved(entry.message, 'cancel', 'timeout').catch(() => {});
    entry.resolve({ behavior: 'deny', message: `Approval timeout ${APPROVAL_TIMEOUT_MS / 1000}s` });
  }, APPROVAL_TIMEOUT_MS);
  try {
    const session = getSession(channelId);
    const toolMessage = entry.args.tool_use_id
      ? await waitForToolMessage(channelId, entry.args.tool_use_id)
      : null;
    const approval = {
      requestId: entry.requestId,
      toolName: entry.args.tool_name,
      toolUseId: entry.args.tool_use_id ?? '',
      input: entry.args.input,
      channelId,
      message: null,
      createdAt: entry.createdAt,
      permissionSuggestions: entry.args.permission_suggestions,
    };
    entry.message = entry.form
      ? await renderQuestionApproval(entry.target, approval, entry.form, toolMessage)
      : entry.args.tool_name === 'ExitPlanMode'
        ? await renderPlanApproval(entry.target, approval, toolMessage)
        : await renderBashApproval(entry.target, approval, session?.cwd ?? '/', toolMessage);
    if (!entry.message) {
      entry.resolve({ behavior: 'deny', message: 'Discord rejected the approval UI' });
      return;
    }
    log.dim(`requestApproval[${channelId}] rendered message=${entry.message.id}`);
  } catch (err) {
    log.warn('requestApproval render fail:', err instanceof Error ? err.message : err);
    entry.resolve({ behavior: 'deny', message: 'Failed to render approval UI' });
  }
}

async function rerenderQuestion(entry: Pending): Promise<void> {
  if (!entry.form) return;
  entry.message = await renderQuestionApproval(
    entry.target,
    {
      requestId: entry.requestId,
      toolName: entry.args.tool_name,
      toolUseId: entry.args.tool_use_id ?? '',
      input: entry.args.input,
      channelId: entry.channelId,
      message: entry.message,
      createdAt: entry.createdAt,
    },
    entry.form,
    entry.message,
  );
}

export async function setQuestionTab(requestId: string, index: number): Promise<boolean> {
  const entry = pending.get(requestId);
  if (!entry?.form || !entry.form.questions[index]) return false;
  entry.form.current = index;
  await rerenderQuestion(entry);
  return true;
}

export async function moveQuestion(requestId: string, delta: -1 | 1): Promise<boolean> {
  const entry = pending.get(requestId);
  if (!entry?.form) return false;
  const next = entry.form.current + delta;
  if (!entry.form.questions[next]) return false;
  entry.form.current = next;
  await rerenderQuestion(entry);
  return true;
}

export async function cycleQuestionOptions(requestId: string): Promise<boolean> {
  const entry = pending.get(requestId);
  if (!entry?.form) return false;
  const question = entry.form.questions[entry.form.current];
  if (!question || question.options.length <= 25) return false;
  entry.form.optionPages ??= entry.form.questions.map(() => 0);
  const pages = Math.ceil(question.options.length / 25);
  entry.form.optionPages[entry.form.current] =
    ((entry.form.optionPages[entry.form.current] ?? 0) + 1) % pages;
  await rerenderQuestion(entry);
  return true;
}

export async function chatAboutQuestion(requestId: string, message: string): Promise<boolean> {
  const entry = pending.get(requestId);
  if (!entry?.form) return false;
  await markApprovalResolved(entry.message, 'cancel', 'continued as chat');
  entry.resolve({ behavior: 'deny', message: `User wants to discuss the question instead: ${message}` });
  return true;
}

export async function selectQuestionOption(
  requestId: string,
  questionIndex: number,
  optionIndex: number,
): Promise<boolean> {
  const entry = pending.get(requestId);
  const form = entry?.form;
  const question = form?.questions[questionIndex];
  const option = question?.options[optionIndex];
  if (!entry || !form || !question || !option) return false;
  const current = form.answers[questionIndex] ?? [];
  form.answers[questionIndex] = question.multiSelect
    ? current.includes(option.label)
      ? current.filter((label) => label !== option.label)
      : [...current, option.label]
    : [option.label];
  if (!question.multiSelect && form.questions[questionIndex + 1]) form.current = questionIndex + 1;
  await rerenderQuestion(entry);
  return true;
}

export async function selectQuestionOptions(
  requestId: string,
  questionIndex: number,
  optionIndices: number[],
): Promise<boolean> {
  const entry = pending.get(requestId);
  const form = entry?.form;
  const question = form?.questions[questionIndex];
  if (!entry || !form || !question) return false;
  const labels = optionIndices
    .map((index) => question.options[index]?.label)
    .filter((label): label is string => typeof label === 'string');
  if (question.multiSelect) {
    const page = form.optionPages?.[questionIndex] ?? 0;
    const visibleLabels = new Set(question.options.slice(page * 25, page * 25 + 25).map((o) => o.label));
    const retained = (form.answers[questionIndex] ?? []).filter((label) => !visibleLabels.has(label));
    form.answers[questionIndex] = [...retained, ...labels];
  } else {
    form.answers[questionIndex] = labels.slice(0, 1);
  }
  if (!question.multiSelect && form.questions[questionIndex + 1]) form.current = questionIndex + 1;
  await rerenderQuestion(entry);
  return true;
}

export async function setQuestionCustomAnswer(
  requestId: string,
  questionIndex: number,
  answer: string,
): Promise<boolean> {
  const entry = pending.get(requestId);
  if (!entry?.form?.questions[questionIndex]) return false;
  entry.form.answers[questionIndex] = [answer];
  if (entry.form.questions[questionIndex + 1]) entry.form.current = questionIndex + 1;
  await rerenderQuestion(entry);
  return true;
}

export async function submitQuestionApproval(requestId: string): Promise<boolean> {
  const entry = pending.get(requestId);
  if (!entry?.form) return false;
  const answers = collectQuestionAnswers(entry.form);
  await markApprovalResolved(entry.message, 'allow', 'answers submitted');
  entry.resolve({ behavior: 'allow', updatedInput: { ...entry.args.input, answers } });
  return true;
}

export function collectQuestionAnswers(form: QuestionFormState): Record<string, string> {
  const answers: Record<string, string> = {};
  form.questions.forEach((question, index) => {
    const answer = form.answers[index];
    if (answer && answer.length > 0) answers[question.question] = answer.join(', ');
  });
  return answers;
}

/** Resolve a terminal approval action from a Discord component. */
export async function resolveApproval(
  requestId: string,
  action: 'yes' | 'always' | 'no' | 'cancel' | string,
  amendedInput?: Record<string, unknown>,
): Promise<boolean> {
  const entry = pending.get(requestId);
  if (!entry) return false;

  let decision: ApprovalDecision;
  let outcome: 'allow' | 'always' | 'deny' | 'cancel' | 'custom' = 'allow';

  switch (action) {
    case 'yes':
      decision = buildApprovalDecision(entry.args, 'yes', amendedInput);
      outcome = amendedInput ? 'custom' : 'allow';
      break;
    case 'always': {
      // Persist only real runtime suggestions through updatedPermissions.
      decision = buildApprovalDecision(entry.args, 'always', amendedInput);
      outcome = 'always';
      break;
    }
    case 'no':
    case 'cancel':
      decision = {
        behavior: 'deny',
        message: action === 'cancel' ? 'User cancelled' : 'User denied',
      };
      outcome = action === 'cancel' ? 'cancel' : 'deny';
      break;
    default:
      decision = { behavior: 'deny', message: `Unknown action: ${action}` };
      outcome = 'deny';
  }

  await markApprovalResolved(entry.message, outcome, amendedInput ? 'amended' : undefined);
  entry.resolve(decision);
  return true;
}

export function buildApprovalDecision(
  args: ApprovalRequestArgs,
  action: 'yes' | 'always',
  amendedInput?: Record<string, unknown>,
): ApprovalDecision {
  return {
    behavior: 'allow',
    updatedInput: amendedInput ?? args.input,
    ...(action === 'always' && args.permission_suggestions?.length
      ? { updatedPermissions: args.permission_suggestions }
      : {}),
  };
}

/** Look up bounded input for an amend modal. */
export function getApproval(requestId: string):
  | { toolName: string; input: Record<string, unknown>; channelId: string }
  | undefined {
  const p = pending.get(requestId);
  if (!p) return undefined;
  return {
    toolName: p.args.tool_name,
    input: p.args.input,
    channelId: p.channelId,
  };
}

/** Explain by returning a JSON representation of the tool input. */
export async function explainApproval(requestId: string): Promise<string | null> {
  const p = pending.get(requestId);
  if (!p) return null;
  const inputStr = JSON.stringify(p.args.input, null, 2);
  return `**Tool:** \`${p.args.tool_name}\`\n**Input:**\n\`\`\`json\n${inputStr.slice(0, 1500)}\n\`\`\``;
}

/** Deny every pending approval when the channel Runner exits. */
export function cleanupChannelApprovals(channelId: string): void {
  const set = byChannel.get(channelId);
  if (!set) return;
  // Remove the queue first so resolving the active item cannot activate the
  // next queued approval while the Runner is shutting down.
  byChannel.delete(channelId);
  for (const rid of set) {
    const entry = pending.get(rid);
    if (entry) {
      void markApprovalResolved(entry.message, 'cancel', 'Runner exit').catch(() => {});
      entry.resolve({ behavior: 'deny', message: 'Runner exited' });
    }
  }
  log.dim(`cleanupChannelApprovals: ${channelId} — ${set.size} approval(s) denied.`);
}
