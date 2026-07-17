import { randomUUID } from 'node:crypto';
import {
  CategoryChannel,
  ChannelType,
  Client,
  TextChannel,
} from 'discord.js';
import { config } from '../config';
import { bridge } from './bridge';
import { buildSessionHeader } from './renderer';
import { allocateSequence, formatSequence } from './sequenceRegistry';
import { getSession, insertSession, listAllSessions, updateBackgroundStatus } from './state';
import { log } from './logger';
import { v2Error, v2Info, V2_FLAGS } from './v2';

export interface BackgroundSessionResult {
  channel: TextChannel;
  created: boolean;
}

const creationFlights = new Map<string, Promise<BackgroundSessionResult | null>>();

export async function createBackgroundSession(
  client: Client,
  creationRequestId: string,
  cwd: string,
): Promise<BackgroundSessionResult | null> {
  const existingFlight = creationFlights.get(creationRequestId);
  if (existingFlight) return existingFlight;

  const flight = createBackgroundSessionOnce(client, creationRequestId, cwd);
  creationFlights.set(creationRequestId, flight);
  try {
    return await flight;
  } finally {
    creationFlights.delete(creationRequestId);
  }
}

async function createBackgroundSessionOnce(
  client: Client,
  creationRequestId: string,
  cwd: string,
): Promise<BackgroundSessionResult | null> {
  const mapped = listAllSessions().find(
    (session) => session.creationRequestId === creationRequestId,
  );
  if (mapped) {
    const channel = await client.channels.fetch(mapped.channelId).catch(() => null);
    if (channel?.type === ChannelType.GuildText) {
      return { channel: channel as TextChannel, created: false };
    }
    log.warn(
      `Background creation request ${creationRequestId} has stale channel ${mapped.channelId}.`,
    );
    return null;
  }

  if (!config.backgroundCategoryId) {
    log.warn('BACKGROUND_CATEGORY_ID is not configured.');
    return null;
  }
  const fetched = await client.channels.fetch(config.backgroundCategoryId).catch(() => null);
  if (!fetched || fetched.type !== ChannelType.GuildCategory) {
    log.err(`BACKGROUND_CATEGORY_ID is not a valid category: ${config.backgroundCategoryId}`);
    return null;
  }
  const category = fetched as CategoryChannel;
  if (category.guildId !== config.guildId) {
    log.err('BACKGROUND_CATEGORY_ID belongs to another guild; refusing channel creation.');
    return null;
  }

  const sequence = allocateSequence(
    config.guildId,
    `background:${creationRequestId || randomUUID()}`,
  );
  const name = `🟠-${formatSequence(sequence)}`;
  const channel = await category.guild.channels
    .create({
      name,
      type: ChannelType.GuildText,
      parent: category.id,
      reason: 'clauderemote background agent',
    })
    .catch((error: Error) => {
      log.err('Unable to create a background agent channel:', error.message);
      return null;
    });
  if (!channel) return null;

  try {
    insertSession(channel.id, cwd, {
      guildId: config.guildId,
      sequenceNumber: sequence,
      source: 'discord',
      sessionType: 'background',
      creationRequestId,
    });
  } catch (error) {
    await channel.delete('Rollback failed background session mapping').catch(() => {});
    log.err(
      'Unable to persist background session mapping:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }

  const header = buildSessionHeader({
    cwd,
    permissionMode: 'bypassPermissions',
  });
  await channel.send({
    components: [header, v2Info('🟠 Background agent · send a message to steer this session · use `/stop` to stop it without deleting its transcript.')],
    flags: V2_FLAGS,
    allowedMentions: { parse: [] },
  }).catch(() => {});

  return { channel, created: true };
}

export async function startBackgroundPrompt(
  result: BackgroundSessionResult,
  prompt: string,
  userId: string,
): Promise<string | null> {
  const session = getSession(result.channel.id);
  if (!session || session.sessionType !== 'background') {
    return 'The background channel mapping is missing or invalid.';
  }
  const { runner, reason } = await bridge.getOrCreate(result.channel);
  if (!runner) {
    updateBackgroundStatus(result.channel.id, 'error');
    await result.channel.send({
      components: [v2Error(reason ?? 'Unable to start the background Runner.')],
      flags: V2_FLAGS,
      allowedMentions: { parse: [] },
    }).catch(() => {});
    return reason ?? 'Unable to start the background Runner.';
  }
  await runner.push(prompt, [], userId, { tag: 'background' });
  return null;
}
