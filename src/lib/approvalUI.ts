import {
  ContainerBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextChannel,
  ThreadChannel,
  Message,
  StringSelectMenuBuilder,
} from 'discord.js';
import { V2_FLAGS } from './v2';
import { escapeCodeFences, scrub } from './scrubber';
import { log } from './logger';

/**
 * Discord UI for Claude Code permission requests.
 * permission mode `manual` / `auto` / `plan`.
 *
 * Three UI forms based on the observed Claude Code interactions:
 * - A. **Bash-style approval**: 3 button top-level [Yes / Yes always / No]
 *   implemented through the shared question form below.
 */

const COLOR_APPROVAL = 0xffa726; // orange-warning

export type ApprovalKind = 'bash' | 'edit-write' | 'generic';

export interface PendingApproval {
  requestId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  channelId: string;
  message: Message | null;
  createdAt: number;
  permissionSuggestions?: unknown[];
}

function td(text: string): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(text.slice(0, 4000));
}

function sepSmall(divider = true): SeparatorBuilder {
  return new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(divider);
}

function safe(t: string, max = 1600): string {
  const s = scrub(t);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function safeCode(t: string, max = 1600): string {
  return escapeCodeFences(safe(t, max));
}

function optionLabel(label: string): { text: string; recommended: boolean } {
  const recommended = /[\[(]?\s*recommended\s*[\])]?/i.test(label);
  const text = label
    .replace(/[\[(]?\s*recommended\s*[\])]?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s·—-]+$/, '')
    .trim();
  return { text: text || label, recommended };
}

/**
 * Format the cwd suffix used by the Always Allow button.
 */
function cwdShort(cwd: string | undefined | null): string {
  if (!cwd) return 'cwd';
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/**
 * Render the Bash-style approval bubble.
 *
 * Button customId format: `cr:appr:<requestId>:<action>`
 *   - action: yes | always | no | amend | explain | cancel
 */
export async function renderBashApproval(
  target: TextChannel | ThreadChannel,
  approval: PendingApproval,
  cwd: string,
  toolMessage?: Message | null,
): Promise<Message | null> {
  const command =
    typeof approval.input.command === 'string' ? approval.input.command : '';
  const description =
    typeof approval.input.description === 'string' ? approval.input.description : '';
  const reason = description ||
    (typeof approval.input.reason === 'string' ? approval.input.reason : '');
  const isEdit = approval.toolName === 'Edit';
  const isWrite = approval.toolName === 'Write';
  const isPlan = approval.toolName === 'ExitPlanMode';
  const filePath = typeof approval.input.file_path === 'string' ? approval.input.file_path : '';
  let fullDiff = '';

  const c = new ContainerBuilder().setAccentColor(COLOR_APPROVAL);
  c.addTextDisplayComponents(
    td(isPlan ? '## 📋 Plan ready for review' : `## 🚦 Approval needed — **${approval.toolName}**`),
  );
  c.addSeparatorComponents(sepSmall(true));
  if (isPlan && typeof approval.input.plan === 'string') {
    c.addTextDisplayComponents(td(safe(approval.input.plan, 3000)));
    const planPath = approval.input.planFilePath;
    if (typeof planPath === 'string') c.addTextDisplayComponents(td(`-# 📄 \`${safe(planPath, 300)}\``));
  } else if (isEdit) {
    if (filePath) c.addTextDisplayComponents(td(`**File:** \`${safe(filePath, 300)}\``));
    const oldText = typeof approval.input.old_string === 'string' ? approval.input.old_string : '';
    const newText = typeof approval.input.new_string === 'string' ? approval.input.new_string : '';
    const diff = [
      ...oldText.split('\n').map((line) => `- ${line}`),
      ...newText.split('\n').map((line) => `+ ${line}`),
    ].join('\n');
    fullDiff = diff;
    const changeKind = oldText.length === 0 ? 'add' : newText.length === 0 ? 'delete' : 'change';
    c.addTextDisplayComponents(td(`-# Change type: **${changeKind}**`));
    c.addTextDisplayComponents(td(`\`\`\`diff\n${safeCode(diff, 2600)}\n\`\`\``));
  } else if (isWrite) {
    if (filePath) c.addTextDisplayComponents(td(`**File:** \`${safe(filePath, 300)}\``));
    const content = typeof approval.input.content === 'string' ? approval.input.content : '';
    fullDiff = content.split('\n').map((line) => `+ ${line}`).join('\n');
    c.addTextDisplayComponents(td('-# Change type: **add/overwrite**'));
    c.addTextDisplayComponents(td(`\`\`\`diff\n${safeCode(fullDiff, 2600)}\n\`\`\``));
  } else if (command) {
    c.addTextDisplayComponents(td(`\`\`\`bash\n${safeCode(command, 1500)}\n\`\`\``));
  } else {
    const input = JSON.stringify(approval.input, null, 2);
    c.addTextDisplayComponents(
      td(`\`\`\`json\n${safeCode(input, 1500)}\n\`\`\``),
    );
  }
  if (reason) {
    c.addTextDisplayComponents(td(`-# **Why:** ${safe(reason, 500)}`));
  }
  c.addTextDisplayComponents(td(isPlan ? '-# Approve this plan or keep planning?' : '-# Do you want to proceed?'));

  const rid = approval.requestId;
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Success)
      .setLabel(isPlan ? 'Approve plan' : 'Yes')
      .setCustomId(`cr:appr:${rid}:yes`),
    ...(isPlan || !approval.permissionSuggestions?.length ? [] : [new ButtonBuilder()
      .setStyle(ButtonStyle.Primary)
      .setLabel(`Yes, always in ${cwdShort(cwd)}`)
      .setCustomId(`cr:appr:${rid}:always`)]),
    new ButtonBuilder()
      .setStyle(ButtonStyle.Danger)
      .setLabel(isPlan ? 'Keep planning' : 'No')
      .setCustomId(`cr:appr:${rid}:no`),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Secondary)
      .setLabel('✏ Amend')
      .setCustomId(`cr:appr:${rid}:amend`),
    new ButtonBuilder()
      .setStyle(ButtonStyle.Secondary)
      .setLabel('❓ Explain')
      .setCustomId(`cr:appr:${rid}:explain`),
    new ButtonBuilder()
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Esc Cancel')
      .setCustomId(`cr:appr:${rid}:cancel`),
  );
  c.addActionRowComponents(row1);
  if (!isPlan) c.addActionRowComponents(row2);

  try {
    const payload = {
      components: [c],
      flags: V2_FLAGS,
      allowedMentions: { parse: [] as never[] },
      ...(fullDiff.length > 2600
        ? { files: [{ attachment: Buffer.from(fullDiff, 'utf8'), name: `${approval.toolName.toLowerCase()}-${approval.toolUseId.slice(-8)}.diff` }] }
        : {}),
    };
    if (toolMessage) {
      await toolMessage.edit(payload as unknown as Parameters<Message['edit']>[0]);
      return toolMessage;
    }
    return await target.send(payload as unknown as Parameters<typeof target.send>[0]);
  } catch (err) {
    log.warn(
      'renderBashApproval fail:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** ExitPlanMode has its own protocol and never exposes generic tool actions. */
export async function renderPlanApproval(
  target: TextChannel | ThreadChannel,
  approval: PendingApproval,
  toolMessage?: Message | null,
): Promise<Message | null> {
  const plan = typeof approval.input.plan === 'string' ? approval.input.plan : '';
  const planFilePath = typeof approval.input.planFilePath === 'string' ? approval.input.planFilePath : '';
  const c = new ContainerBuilder().setAccentColor(COLOR_APPROVAL);
  c.addTextDisplayComponents(td('## 📋 Plan ready for review'));
  c.addSeparatorComponents(sepSmall(true));
  c.addTextDisplayComponents(td(plan ? safe(plan, 3000) : '_Claude did not provide plan text._'));
  if (planFilePath) c.addTextDisplayComponents(td(`-# 📄 \`${safe(planFilePath, 300)}\``));
  if (Array.isArray(approval.input.allowedPrompts) && approval.input.allowedPrompts.length > 0) {
    c.addTextDisplayComponents(td(`-# Requested implementation permissions: ${approval.input.allowedPrompts.length}`));
  }
  c.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Success)
      .setLabel('Approve plan')
      .setCustomId(`cr:appr:${approval.requestId}:yes`),
    new ButtonBuilder()
      .setStyle(ButtonStyle.Danger)
      .setLabel('Keep planning')
      .setCustomId(`cr:appr:${approval.requestId}:no`),
  ));
  const payload = {
    components: [c],
    flags: V2_FLAGS,
    allowedMentions: { parse: [] as never[] },
    ...(plan.length > 3000 ? { files: [{ attachment: Buffer.from(plan, 'utf8'), name: 'claude-plan.md' }] } : {}),
  };
  try {
    if (toolMessage) {
      await toolMessage.edit(payload as unknown as Parameters<Message['edit']>[0]);
      return toolMessage;
    }
    return await target.send(payload as unknown as Parameters<typeof target.send>[0]);
  } catch (error) {
    log.warn('renderPlanApproval failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 */
export interface RadioOption {
  label: string;
  subtext?: string;
  special?: 'input' | 'escape';
}

export interface ApprovalQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface QuestionFormState {
  questions: ApprovalQuestion[];
  current: number;
  answers: string[][];
  optionPages?: number[];
}

export async function renderQuestionApproval(
  target: TextChannel | ThreadChannel,
  approval: PendingApproval,
  state: QuestionFormState,
  toolMessage?: Message | null,
): Promise<Message | null> {
  const q = state.questions[state.current];
  if (!q) return null;
  const c = new ContainerBuilder().setAccentColor(COLOR_APPROVAL);
  c.addTextDisplayComponents(td(`## ❓ ${safe(q.header || 'Question', 100)}`));
  c.addTextDisplayComponents(td(safe(q.question, 500)));
  c.addSeparatorComponents(sepSmall(true));
  c.addTextDisplayComponents(td(q.options.map((o, i) => {
    const display = optionLabel(o.label);
    return `**${i + 1}. ${display.recommended ? '⭐ ' : ''}${safe(display.text, 100)}**${o.description ? `\n-# ${safe(o.description, 240)}` : ''}`;
  }).join('\n\n')));

  const rid = approval.requestId;
  if (state.questions.length > 1) {
    const tabStart = Math.floor(state.current / 25) * 25;
    const tabs = new StringSelectMenuBuilder()
      .setCustomId(`cr:appr:qtab:${rid}`)
      .setPlaceholder('Select a question')
      .addOptions(state.questions.slice(tabStart, tabStart + 25).map((item, localIndex) => {
        const i = tabStart + localIndex;
        return {
        label: `${state.answers[i]?.length ? '✓ ' : ''}${item.header || `Question ${i + 1}`}`.slice(0, 100),
        value: String(i),
        default: i === state.current,
        };
      }));
    c.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(tabs));
  }

  const selected = state.answers[state.current] ?? [];
  const optionPage = state.optionPages?.[state.current] ?? 0;
  const optionStart = optionPage * 25;
  const visibleOptions = q.options.slice(optionStart, optionStart + 25);
  const picker = new StringSelectMenuBuilder()
    .setCustomId(`cr:appr:qpick:${rid}:${state.current}`)
    .setPlaceholder(q.multiSelect ? 'Select one or more options' : 'Select one option')
    .setMinValues(q.multiSelect ? 0 : 1)
    .setMaxValues(q.multiSelect ? Math.min(visibleOptions.length, 25) : 1)
    .addOptions(visibleOptions.map((option, localIndex) => {
      const i = optionStart + localIndex;
      const display = optionLabel(option.label);
      return {
        label: `${display.recommended ? '⭐ ' : ''}${display.text}`.slice(0, 100),
        description: option.description?.slice(0, 100),
        value: String(i),
        default: selected.includes(option.label),
      };
    }));
  c.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(picker));

  const buttons = [
    new ButtonBuilder()
      .setCustomId(`cr:appr:${rid}:qprev`)
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(state.current === 0),
    new ButtonBuilder()
      .setCustomId(`cr:appr:${rid}:qnext`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(state.current >= state.questions.length - 1),
    new ButtonBuilder()
      .setCustomId(`cr:appr:${rid}:qother:${state.current}`)
      .setLabel('Type something…')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`cr:appr:${rid}:qchat:${state.current}`)
      .setLabel('Chat about this')
      .setStyle(ButtonStyle.Secondary),
    ...(q.options.length > 25 ? [new ButtonBuilder()
      .setCustomId(`cr:appr:${rid}:qmore`)
      .setLabel(`Options ${optionPage + 1}/${Math.ceil(q.options.length / 25)} ▶`)
      .setStyle(ButtonStyle.Secondary)] : []),
  ];
  c.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));

  c.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`cr:appr:${rid}:qsubmit`)
      .setLabel('Submit answers')
      .setStyle(ButtonStyle.Success)
      .setDisabled(false),
    new ButtonBuilder()
      .setCustomId(`cr:appr:${rid}:cancel`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  ));

  try {
    if (toolMessage) {
      await toolMessage.edit({ components: [c], flags: V2_FLAGS, allowedMentions: { parse: [] } } as unknown as Parameters<Message['edit']>[0]);
      return toolMessage;
    }
    return await target.send({ components: [c], flags: V2_FLAGS, allowedMentions: { parse: [] } });
  } catch (err) {
    log.warn('renderQuestionApproval fail:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function renderRadioApproval(
  target: TextChannel | ThreadChannel,
  approval: PendingApproval,
  question: string,
  options: RadioOption[],
  toolMessage?: Message | null,
): Promise<Message | null> {
  const c = new ContainerBuilder().setAccentColor(COLOR_APPROVAL);
  c.addTextDisplayComponents(td(`## ❓ ${safe(question, 300)}`));
  c.addSeparatorComponents(sepSmall(true));

  const lines = options.map((o, i) => {
    const num = i + 1;
    const line = `**${num}.** ${safe(o.label, 200)}`;
    return o.subtext ? `${line}\n  -# ${safe(o.subtext, 300)}` : line;
  });
  c.addTextDisplayComponents(td(lines.join('\n\n')));

  const rid = approval.requestId;
  const buttons: ButtonBuilder[] = options.slice(0, 25).map((o, i) => {
    const style =
      o.special === 'input'
        ? ButtonStyle.Primary
        : o.special === 'escape'
          ? ButtonStyle.Secondary
          : ButtonStyle.Success;
    return new ButtonBuilder()
      .setStyle(style)
      .setLabel(`${i + 1}. ${o.label.slice(0, 60)}`)
      .setCustomId(`cr:appr:${rid}:opt:${i}`);
  });

  for (let i = 0; i < buttons.length; i += 5) {
    c.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)),
    );
  }

  try {
    const payload = {
      components: [c],
      flags: V2_FLAGS,
      allowedMentions: { parse: [] as never[] },
    };
    if (toolMessage) {
      await toolMessage.edit(payload as unknown as Parameters<Message['edit']>[0]);
      return toolMessage;
    }
    return await target.send(payload as unknown as Parameters<typeof target.send>[0]);
  } catch (err) {
    log.warn(
      'renderRadioApproval fail:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 */
export async function markApprovalResolved(
  message: Message | null,
  outcome: 'allow' | 'deny' | 'always' | 'cancel' | 'custom',
  note?: string,
): Promise<void> {
  if (!message) return;
  const emoji =
    outcome === 'allow'
      ? '✅'
      : outcome === 'always'
        ? '✅'
        : outcome === 'deny'
          ? '❌'
          : outcome === 'cancel'
            ? '⏹'
            : '✏';
  const c = new ContainerBuilder().setAccentColor(
    outcome === 'deny' || outcome === 'cancel' ? 0x99aab5 : 0x77dd77,
  );
  c.addTextDisplayComponents(td(`${emoji} Approval → **${outcome}**${note ? ` — ${safe(note, 200)}` : ''}`));
  try {
    await message.edit({
      components: [c],
      flags: V2_FLAGS,
      allowedMentions: { parse: [] },
    } as unknown as Parameters<Message['edit']>[0]);
  } catch (err) {
    log.warn('markApprovalResolved edit fail:', err instanceof Error ? err.message : err);
  }
}
