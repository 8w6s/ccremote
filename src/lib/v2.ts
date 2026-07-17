import {
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
  ChatInputCommandInteraction,
  MessageComponentInteraction,
  ModalSubmitInteraction,
  InteractionResponse,
  Message,
} from 'discord.js';
import { BRAND_COLOR } from './embeds';

/**
 * Components V2 factory for clauderemote.
 */

const OK = 0x77dd77;
const ERR = 0xff6961;
const WARN = 0xffcc66;

const BRAND_FOOTER = 'clauderemote';

export const V2_FLAGS = MessageFlags.IsComponentsV2;
export const V2_FLAGS_EPHEMERAL = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

const TEXT_MAX = 4000;
const CONTAINER_CHILD_MAX = 40;

function safeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  const trimmed = u.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return null;
  return trimmed;
}

function td(text: string): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(text.slice(0, TEXT_MAX));
}

function sepSmall(divider = true): SeparatorBuilder {
  return new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(divider);
}

function footerBlock(text = BRAND_FOOTER): [SeparatorBuilder, TextDisplayBuilder] {
  return [sepSmall(false), td(`-# ${text}`)];
}

function fieldsToText(fields: V2FieldRow[]): string {
  if (!fields.length) return '';
  const lines: string[] = [];
  let total = 0;
  for (let i = 0; i < fields.length; i += 2) {
    const a = fields[i];
    const b = fields[i + 1];
    const left = `**${a.label}:** ${a.value}`;
    const line = b ? `${left}  •  **${b.label}:** ${b.value}` : left;
    if (total + line.length + 1 > TEXT_MAX - 100) {
      lines.push('…');
      break;
    }
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join('\n');
}

function containerSize(c: ContainerBuilder): number {
  const cast = c as unknown as { components?: unknown[] };
  return Array.isArray(cast.components) ? cast.components.length : 0;
}

function safeAddText(c: ContainerBuilder, text: string): void {
  if (containerSize(c) >= CONTAINER_CHILD_MAX - 1) return;
  c.addTextDisplayComponents(td(text));
}
function safeAddSep(c: ContainerBuilder, sep: SeparatorBuilder): void {
  if (containerSize(c) >= CONTAINER_CHILD_MAX - 1) return;
  c.addSeparatorComponents(sep);
}
function safeAddSection(c: ContainerBuilder, section: SectionBuilder): void {
  if (containerSize(c) >= CONTAINER_CHILD_MAX - 1) return;
  c.addSectionComponents(section);
}

export interface V2FieldRow {
  label: string;
  value: string;
}

export interface V2PanelOpts {
  title: string;
  body?: string;
  thumb?: string | null;
  banner?: string | null;
  fields?: V2FieldRow[];
  footer?: string;
  accent?: number;
  buttons?: ButtonBuilder[];
  select?: StringSelectMenuBuilder;
}

export interface V2StatusOpts {
  state: 'ok' | 'err' | 'warn' | 'info';
  title: string;
  description?: string;
  thumb?: string | null;
  fields?: V2FieldRow[];
  footer?: string;
}

const TOAST_BODY_MAX = 3900;

function clampToast(msg: string): string {
  if (msg.length <= TOAST_BODY_MAX) return msg;
  return msg.slice(0, TOAST_BODY_MAX - 1) + '…';
}

export function v2Ok(msg: string): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(OK)
    .addTextDisplayComponents(td(clampToast(msg)));
}

export function v2Error(msg: string): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(ERR)
    .addTextDisplayComponents(td(clampToast(msg)));
}

export function v2Info(msg: string): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(BRAND_COLOR)
    .addTextDisplayComponents(td(clampToast(msg)));
}

export function v2Warn(msg: string): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(WARN)
    .addTextDisplayComponents(td(clampToast(msg)));
}

export function v2Panel(opts: V2PanelOpts): ContainerBuilder {
  const c = new ContainerBuilder().setAccentColor(opts.accent ?? BRAND_COLOR);

  const banner = safeUrl(opts.banner);
  if (banner) {
    c.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(banner)),
    );
  }

  safeAddText(c, `# ${opts.title}`);

  const thumb = safeUrl(opts.thumb);
  if (opts.body || thumb) {
    safeAddSep(c, sepSmall(true));
    if (thumb) {
      const section = new SectionBuilder()
        .addTextDisplayComponents(td(opts.body ?? '​'))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb));
      safeAddSection(c, section);
    } else if (opts.body) {
      safeAddText(c, opts.body);
    }
  }

  if (opts.fields?.length) {
    safeAddSep(c, sepSmall(true));
    safeAddText(c, fieldsToText(opts.fields));
  }

  if (opts.buttons?.length && containerSize(c) < CONTAINER_CHILD_MAX - 1) {
    safeAddSep(c, sepSmall(true));
    c.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(...opts.buttons.slice(0, 5)),
    );
  }

  if (opts.select && containerSize(c) < CONTAINER_CHILD_MAX - 1) {
    safeAddSep(c, sepSmall(true));
    c.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(opts.select),
    );
  }

  const [footSep] = footerBlock(opts.footer ?? BRAND_FOOTER);
  safeAddSep(c, footSep);
  safeAddText(c, `-# ${opts.footer ?? BRAND_FOOTER}`);

  return c;
}

const STATE_ACCENT: Record<V2StatusOpts['state'], number> = {
  ok: OK,
  err: ERR,
  warn: WARN,
  info: BRAND_COLOR,
};

export function v2StatusCard(opts: V2StatusOpts): ContainerBuilder {
  const c = new ContainerBuilder().setAccentColor(STATE_ACCENT[opts.state]);
  safeAddText(c, `# ${opts.title}`);

  const bodyText = opts.description
    ? (opts.fields?.length
        ? `${opts.description}\n\n${fieldsToText(opts.fields)}`
        : opts.description)
    : fieldsToText(opts.fields ?? []);

  const thumb = safeUrl(opts.thumb);
  if (bodyText || thumb) {
    safeAddSep(c, sepSmall(true));
    if (thumb) {
      const section = new SectionBuilder()
        .addTextDisplayComponents(td(bodyText || '​'))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb));
      safeAddSection(c, section);
    } else if (bodyText) {
      safeAddText(c, bodyText);
    }
  }

  const [footSep] = footerBlock(opts.footer ?? BRAND_FOOTER);
  safeAddSep(c, footSep);
  safeAddText(c, `-# ${opts.footer ?? BRAND_FOOTER}`);

  return c;
}

type SlashLikeInteraction =
  | ChatInputCommandInteraction
  | MessageComponentInteraction
  | ModalSubmitInteraction;

export async function replyV2(
  interaction: SlashLikeInteraction,
  container: ContainerBuilder,
  opts?: { ephemeral?: boolean },
): Promise<InteractionResponse | Message> {
  if (interaction.deferred) {
    return interaction.editReply({
      components: [container],
      flags: V2_FLAGS,
      allowedMentions: { parse: [] },
    } as unknown as Parameters<SlashLikeInteraction['editReply']>[0]);
  }
  if (interaction.replied) {
    return interaction.followUp({
      components: [container],
      flags: opts?.ephemeral ? V2_FLAGS_EPHEMERAL : V2_FLAGS,
      allowedMentions: { parse: [] },
    });
  }
  return interaction.reply({
    components: [container],
    flags: opts?.ephemeral ? V2_FLAGS_EPHEMERAL : V2_FLAGS,
    allowedMentions: { parse: [] },
  });
}

export function editReplyV2(
  interaction: SlashLikeInteraction,
  container: ContainerBuilder,
): Promise<Message> {
  return interaction.editReply({
    components: [container],
    flags: V2_FLAGS,
    allowedMentions: { parse: [] },
  } as unknown as Parameters<SlashLikeInteraction['editReply']>[0]);
}

export function followUpV2(
  interaction: SlashLikeInteraction,
  container: ContainerBuilder,
  opts?: { ephemeral?: boolean },
): Promise<Message> {
  return interaction.followUp({
    components: [container],
    flags: opts?.ephemeral ? V2_FLAGS_EPHEMERAL : V2_FLAGS,
    allowedMentions: { parse: [] },
  });
}
