import {
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  TextChannel,
  CategoryChannel,
} from 'discord.js';
import { config } from '../config';
import { v2Panel, V2_FLAGS } from './v2';
import { log } from './logger';
import { insertSession, listClosedSessions } from './state';
import { buildSessionHeader } from './renderer';
import { randomUUID } from 'node:crypto';
import { allocateSequence, formatSequence } from './sequenceRegistry';

const HUB_TITLE = '🟣 clauderemote';
const HUB_MARKER = '<!-- clauderemote:hub -->';
const DISCORD_CATEGORY_CHANNEL_LIMIT = 50;
let archiveMoveTail: Promise<void> = Promise.resolve();

export function nextArchiveOverflowName(baseName: string, existingNames: Iterable<string>): string {
  const prefix = `${baseName}-overflow`;
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const numbered = new RegExp(`^${escapedPrefix}[ -](\\d+)$`, 'i');
  const used = new Set<number>();
  for (const name of existingNames) {
    if (name.toLowerCase() === prefix.toLowerCase()) {
      used.add(1); // Legacy unsuffixed overflow is treated as 0001.
      continue;
    }
    const match = name.match(numbered);
    if (match) used.add(Number(match[1]));
  }
  let index = 1;
  while (used.has(index)) index++;
  return `${prefix} ${String(index).padStart(4, '0')}`.slice(0, 100);
}

function buildHubContainer() {
  return v2Panel({
    title: HUB_TITLE,
    body:
      'Control Claude Code from Discord.\n' +
      '\n' +
      '• Press **New Session** to create a dedicated channel.\n' +
      '• Messages in a session channel are sent to Claude Code.\n' +
      '• Subagents run in dedicated threads.\n' +
      '• Assistant text streams live; tool calls update in place.\n' +
      '• Use `/mode` to select the permission policy.\n' +
      '\n' +
      'Use `/close` to archive a session and `/status` for details.',
    fields: [
      { label: 'Owner', value: `<@${config.ownerId}>` },
      { label: 'Default CWD', value: `\`${config.defaultCwd}\`` },
      { label: 'Rate limit', value: `${config.maxPromptsPerHour}/h` },
    ],
    footer: HUB_MARKER,
    buttons: [
      new ButtonBuilder()
        .setCustomId('cr:new-session')
        .setLabel('New Session')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🟣'),
    ],
  });
}

/**
 */
export async function ensureHub(client: Client): Promise<void> {
  const channel = await client.channels.fetch(config.hubChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    log.err(`HUB_CHANNEL_ID is not a valid text channel: ${config.hubChannelId}`);
    return;
  }

  const text = channel as TextChannel;
  if (text.guildId !== config.guildId) {
    log.err(
      `HUB_CHANNEL_ID=${config.hubChannelId} belongs to guild ${text.guildId}, ` +
        `not configured GUILD_ID=${config.guildId}. Aborting hub setup.`,
    );
    return;
  }
  const recent = await text.messages.fetch({ limit: 50 }).catch(() => null);
  if (recent) {
    const existing = recent.find(
      (m) =>
        m.author.id === client.user?.id &&
        m.components?.length &&
        JSON.stringify(m.components).includes(HUB_MARKER),
    );
    if (existing) {
      await existing.edit({
        components: [buildHubContainer()],
        flags: V2_FLAGS,
        allowedMentions: { parse: [] },
      } as unknown as Parameters<typeof existing.edit>[0]).catch((error: Error) => {
        log.warn('Unable to refresh the existing hub message:', error.message);
      });
      log.dim(`Refreshed existing hub message (id=${existing.id}).`);
      return;
    }
  }

  await text.send({
    components: [buildHubContainer()],
    flags: V2_FLAGS,
    allowedMentions: { parse: [] },
  });
  log.ok('Posted the hub message.');
}

/**
 * Create one mapped session text channel under CATEGORY_ID.
 */
export async function createSessionChannel(
  client: Client,
): Promise<{ channelId: string; name: string } | null> {
  const cat = await client.channels.fetch(config.categoryId).catch(() => null);
  if (!cat || cat.type !== ChannelType.GuildCategory) {
    log.err(`CATEGORY_ID is not a valid category: ${config.categoryId}`);
    return null;
  }
  const category = cat as CategoryChannel;
  if (category.guildId !== config.guildId) {
    log.err('CATEGORY_ID does not belong to the configured GUILD_ID; refusing session creation.');
    return null;
  }

  const guild = category.guild;

  const sequence = allocateSequence(config.guildId, `discord:${randomUUID()}`);
  const rawName = `🟣-${formatSequence(sequence)}`;
  const name = rawName.toLowerCase().replace(/[^a-z0-9\-🟣]/gu, '-').slice(0, 90);

  const channel = await guild.channels
    .create({
      name,
      type: ChannelType.GuildText,
      parent: category.id,
      reason: 'clauderemote session',
    })
    .catch((err: Error) => {
      log.err('Unable to create a session channel:', err.message);
      return null;
    });

  if (!channel) return null;

  try {
    insertSession(channel.id, config.defaultCwd, {
      guildId: config.guildId,
      sequenceNumber: sequence,
      source: 'discord',
    });
  } catch (error) {
    await channel.delete('Rollback failed clauderemote mapping insert').catch(() => {});
    log.err('Unable to persist new session mapping:', error instanceof Error ? error.message : error);
    return null;
  }

  const header = buildSessionHeader({
    cwd: config.defaultCwd,
    permissionMode: 'bypassPermissions',
  });
  await channel
    .send({
      components: [header],
      flags: V2_FLAGS,
      allowedMentions: { parse: [] },
    })
    .catch(() => {});

  return { channelId: channel.id, name: channel.name };
}

/** Apply or remove the closed-channel prefix; missing permissions are non-fatal. */
export async function renameSessionChannel(
  channel: TextChannel,
  prefix: string,
): Promise<void> {
  try {
    if (prefix === '') {
      const unlocked = channel.name.replace(/^🔒[-\s]*/, '').slice(0, 90);
      if (unlocked !== channel.name) await channel.setName(unlocked);
      return;
    }
    if (channel.name.startsWith(prefix)) return;
    const newName = `${prefix}${channel.name}`.slice(0, 90);
    await channel.setName(newName);
  } catch {
    /* missing perm — ignore */
  }
}

export async function moveToActive(channel: TextChannel): Promise<boolean> {
  if (channel.parentId === config.categoryId) return true;
  const cat = await channel.client.channels.fetch(config.categoryId).catch(() => null);
  if (!cat || cat.type !== ChannelType.GuildCategory) {
    log.warn(`CATEGORY_ID=${config.categoryId} is not a valid active category.`);
    return false;
  }
  const target = cat as CategoryChannel;
  if (target.guildId !== config.guildId) return false;
  try {
    await channel.setParent(target.id, { lockPermissions: false });
    return true;
  } catch (err) {
    log.warn('moveToActive failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Move a closed session channel to ARCHIVE_CATEGORY_ID.
 */
export async function moveToArchive(channel: TextChannel): Promise<boolean> {
  const previous = archiveMoveTail;
  let release!: () => void;
  archiveMoveTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await moveToArchiveLocked(channel);
  } finally {
    release();
  }
}

async function moveToArchiveLocked(channel: TextChannel): Promise<boolean> {
  const id = config.archiveCategoryId;
  if (!id) return false;
  const cat = await channel.client.channels.fetch(id).catch(() => null);
  if (!cat) {
    log.warn(`ARCHIVE_CATEGORY_ID=${id} does not exist or is not visible to the bot.`);
    return false;
  }
  if (cat.type !== ChannelType.GuildCategory) {
    log.warn(`ARCHIVE_CATEGORY_ID=${id} is not a category (type=${cat.type}); skipping archive move.`);
    return false;
  }
  const target = cat as CategoryChannel;
  if (target.guildId !== config.guildId) {
    log.warn('ARCHIVE_CATEGORY_ID belongs to another guild; skipping archive move.');
    return false;
  }
  try {
    const guild = target.guild;
    const escaped = target.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const overflowPattern = new RegExp(`^${escaped}-overflow(?:[ -](\\d+))?$`, 'i');
    const candidates = [
      target,
      ...guild.channels.cache
        .filter((candidate) =>
          candidate.type === ChannelType.GuildCategory &&
          candidate.id !== target.id &&
          overflowPattern.test(candidate.name),
        )
        .map((candidate) => candidate as CategoryChannel),
    ].sort((a, b) => {
      if (a.id === target.id) return -1;
      if (b.id === target.id) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    // Migrate the pre-1.0 unsuffixed category without moving its children.
    const legacyName = `${target.name}-overflow`;
    const legacy = candidates.find((candidate) => candidate.name.toLowerCase() === legacyName.toLowerCase());
    const firstNumberedName = `${legacyName} 0001`;
    const hasFirstNumbered = candidates.some(
      (candidate) => candidate.name.toLowerCase() === firstNumberedName.toLowerCase(),
    );
    if (legacy && !hasFirstNumbered) {
      await legacy.setName(firstNumberedName, 'Normalize ccRemote archive overflow numbering');
    }

    let destination = candidates.find((candidate) =>
      channel.parentId === candidate.id || candidate.children.cache.size < DISCORD_CATEGORY_CHANNEL_LIMIT,
    );
    if (!destination) {
      const name = nextArchiveOverflowName(target.name, candidates.map((candidate) => candidate.name));
      destination = await guild.channels.create({
        name,
        type: ChannelType.GuildCategory,
        reason: 'ccRemote archive overflow',
      });
    }
    if (channel.parentId !== destination.id) {
      await channel.setParent(destination.id, { lockPermissions: false });
    }
    return true;
  } catch (err) {
    log.warn('moveToArchive failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

export async function reconcileClosedSessionArchives(client: Client): Promise<number> {
  if (!config.archiveCategoryId) return 0;
  let moved = 0;
  for (const session of listClosedSessions()) {
    const ch = await client.channels.fetch(session.channelId).catch(() => null);
    if (!ch || ch.type !== ChannelType.GuildText) continue;
    const text = ch as TextChannel;
    if (text.parentId === config.archiveCategoryId) continue;
    if (await moveToArchive(text)) moved++;
  }
  if (moved > 0) log.dim(`Archive reconcile: moved ${moved} closed session channel(s).`);
  return moved;
}
