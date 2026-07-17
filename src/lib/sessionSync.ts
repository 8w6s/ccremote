import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { allocateSequence, bootstrapSequences, formatSequence } from './sequenceRegistry';
import { ChannelType, Client, Message, TextChannel } from 'discord.js';
import { config } from '../config';
import {
  findSessionByUuid,
  finishSessionSync,
  insertImportedSession,
  setSessionSyncFlags,
  migrateSessionMetadata,
  getSession,
  updateSessionSyncProgress,
  listAllSessions,
  updateSessionMappingHealth,
} from './state';
import { jsonlMirror } from './jsonlMirror';
import { log } from './logger';

export interface DiscoveredSession {
  uuid: string;
  cwd: string;
  path: string;
  mtimeMs: number;
  bytes: number;
  createdAtMs: number;
}

export function metadataFromJsonl(path: string): { cwd: string | null; timestamp: number | null } {
  let fd: number | null = null;
  let firstCwd: string | null = null;
  let firstTimestamp: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(256 * 1024);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const sample = buffer.toString('utf8', 0, bytesRead);
    for (const line of sample.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const cwd = typeof event.cwd === 'string' && event.cwd.startsWith('/') ? event.cwd : null;
        const rawTimestamp = event.timestamp;
        const timestamp = typeof rawTimestamp === 'string' || typeof rawTimestamp === 'number'
          ? new Date(rawTimestamp).getTime()
          : NaN;
        if (!firstCwd && cwd) firstCwd = cwd;
        if (firstTimestamp == null && Number.isFinite(timestamp)) firstTimestamp = timestamp;
        if (firstCwd && firstTimestamp != null) break;
      } catch {
        /* malformed/partial line */
      }
    }
  } catch {
    /* unreadable */
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return { cwd: firstCwd, timestamp: firstTimestamp };
}

export function discoverClaudeSessions(): DiscoveredSession[] {
  const root = join(homedir(), '.claude', 'projects');
  const found = new Map<string, DiscoveredSession>();
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
  for (const dir of dirs) {
    const projectDir = join(root, dir.name);
    let names: string[];
    try {
      names = readdirSync(projectDir).filter((name) => /^[0-9a-f-]{32,}\.jsonl$/i.test(name));
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(projectDir, name);
      const stat = statSync(path);
      const metadata = metadataFromJsonl(path);
      if (!metadata.cwd) continue;
      const cwd = metadata.cwd;
      const uuid = basename(path, '.jsonl');
      const createdAtMs = metadata.timestamp ?? (stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs);
      const candidate = { uuid, cwd, path, mtimeMs: stat.mtimeMs, bytes: stat.size, createdAtMs };
      const previous = found.get(uuid);
      if (!previous || candidate.mtimeMs > previous.mtimeMs) found.set(uuid, candidate);
    }
  }
  return [...found.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function bootstrapSessionIdentity(): { discovered: number; migrated: number } {
  const sessions = discoverClaudeSessions();
  bootstrapSequences(config.guildId, sessions);
  const migrated = migrateSessionMetadata(
    config.guildId,
    sessions,
    (identity) => allocateSequence(config.guildId, identity),
  );
  return { discovered: sessions.length, migrated };
}

export async function reconcileSessionMappings(client: Client): Promise<{
  healthy: number;
  stale: number;
  duplicates: number;
}> {
  const rows = listAllSessions();
  const uuidGroups = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.sessionUuid) continue;
    const key = `${row.guildId ?? config.guildId}:${row.sessionUuid}`;
    const group = uuidGroups.get(key) ?? [];
    group.push(row);
    uuidGroups.set(key, group);
  }
  const duplicateChannels = new Set<string>();
  for (const group of uuidGroups.values()) {
    if (group.length > 1) for (const row of group) duplicateChannels.add(row.channelId);
  }
  let healthy = 0;
  let stale = 0;
  for (const row of rows) {
    if (duplicateChannels.has(row.channelId)) {
      updateSessionMappingHealth(row.channelId, 'duplicate');
      continue;
    }
    const channel = await client.channels.fetch(row.channelId).catch(() => null);
    if (!channel || row.channelDeleted) {
      updateSessionMappingHealth(row.channelId, 'stale');
      stale++;
    } else if (row.sessionUuid && row.jsonlPath && !existsSync(row.jsonlPath)) {
      updateSessionMappingHealth(row.channelId, 'missing-jsonl');
      stale++;
    } else {
      updateSessionMappingHealth(row.channelId, 'healthy');
      healthy++;
    }
  }
  return { healthy, stale, duplicates: duplicateChannels.size };
}

function channelName(prefix: string, sequence: number): string {
  return `${prefix}-${formatSequence(sequence)}`.toLowerCase().slice(0, 90);
}

let replayQueue: Promise<void> = Promise.resolve();
const channelSingleflight = new Map<string, Promise<TextChannel>>();

function enqueueReplay(task: () => Promise<void>): void {
  replayQueue = replayQueue.then(task, task);
}

function allowedCwd(cwd: string): boolean {
  return config.allowedCwdPrefixes.some((prefix) => cwd === prefix || cwd.startsWith(`${prefix}/`));
}

export async function createSyncedSession(
  client: Client,
  source: DiscoveredSession,
  opts: { fork?: boolean } = {},
): Promise<TextChannel> {
  if (opts.fork) return createSyncedSessionInternal(client, source, opts);
  const mapped = findSessionByUuid(source.uuid);
  if (mapped) {
    const existing = await client.channels.fetch(mapped.channelId).catch(() => null);
    if (existing?.type === ChannelType.GuildText) return existing as TextChannel;
    throw new Error(`Stale mapping: session ${source.uuid} points to missing channel ${mapped.channelId}`);
  }
  const key = `${config.guildId}:${source.uuid}`;
  const inflight = channelSingleflight.get(key);
  if (inflight) return inflight;
  const promise = createSyncedSessionInternal(client, source, opts);
  channelSingleflight.set(key, promise);
  try {
    return await promise;
  } finally {
    if (channelSingleflight.get(key) === promise) channelSingleflight.delete(key);
  }
}

async function createSyncedSessionInternal(
  client: Client,
  source: DiscoveredSession,
  opts: { fork?: boolean },
): Promise<TextChannel> {
  const category = await client.channels.fetch(config.categoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) throw new Error('CATEGORY_ID invalid');
  const sequence = allocateSequence(config.guildId, opts.fork ? `fork:${randomUUID()}` : source.uuid);
  const channel = await category.guild.channels.create({
    name: channelName('[0%]', sequence),
    type: ChannelType.GuildText,
    parent: category.id,
    reason: opts.fork ? 'clauderemote branch sync' : 'clauderemote local session import',
  });
  try {
    insertImportedSession(
      channel.id,
      source.cwd,
      opts.fork ? null : source.uuid,
      opts.fork ? source.uuid : null,
      {
        guildId: config.guildId,
        jsonlPath: source.path,
        sequenceNumber: sequence,
        source: opts.fork ? 'branch' : 'cli-local',
        syncTotal: source.bytes,
      },
    );
  } catch (error) {
    await channel.delete('Rollback duplicate clauderemote session mapping').catch(() => {});
    const mapped = !opts.fork ? findSessionByUuid(source.uuid) : null;
    if (mapped) {
      const existing = await client.channels.fetch(mapped.channelId).catch(() => null);
      if (existing?.type === ChannelType.GuildText) return existing as TextChannel;
    }
    throw error;
  }
  setSessionSyncFlags(channel.id, true, !allowedCwd(source.cwd));
  const progress = await channel.send({ content: '🔄 Sync transcript: **0%**' });
  enqueueReplay(() => runReplay(channel, progress, source, opts.fork === true, sequence));
  return channel;
}

async function runReplay(channel: TextChannel, progress: Message, source: DiscoveredSession, isFork: boolean, sequence: number): Promise<void> {
  let lastEdit = 0;
  try {
    const checkpoint = isFork ? 0 : (getSession(channel.id)?.syncCheckpoint ?? 0);
    const result = await jsonlMirror.replayFile(channel.id, source.path, async (sync) => {
      updateSessionSyncProgress(channel.id, sync.checkpoint, sync.totalBytes, 'running');
      const now = Date.now();
      if (sync.percent < 100 && now - lastEdit < 1200) return;
      lastEdit = now;
      const eta = sync.etaMs != null && sync.etaMs > 0 ? ` · ETA ${formatEta(sync.etaMs)}` : '';
      await progress.edit(
        `🔄 Sync transcript: **${sync.eventsDone}/${sync.totalEvents} events** · **${sync.percent}%**${eta}`,
      ).catch(() => {});
    }, checkpoint);
    finishSessionSync(channel.id);
    await progress.edit(`✅ Sync complete · ${result.rendered} events${result.malformed ? ` · ${result.malformed} malformed` : ''}`).catch(() => {});
    await channel.setName(channelName('🟣', sequence)).catch((err) => {
      log.warn('sync final rename failed:', err instanceof Error ? err.message : err);
    });
    if (!isFork) await jsonlMirror.armWatcher(channel.id, source.path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setSessionSyncFlags(channel.id, false, true);
    const failed = getSession(channel.id);
    updateSessionSyncProgress(
      channel.id,
      failed?.syncCheckpoint ?? 0,
      failed?.syncTotal ?? source.bytes,
      'error',
    );
    await progress.edit(`❌ Sync failed: ${message.slice(0, 1500)}`).catch(() => {});
    await channel.setName(channelName('[err]', sequence)).catch(() => {});
    log.warn(`session sync ${source.uuid} failed: ${message}`);
  }
}

export async function resumeIncompleteSyncs(client: Client): Promise<number> {
  let resumed = 0;
  for (const row of listAllSessions()) {
    if (!row.jsonlPath || !row.sessionUuid || !row.sequenceNumber) continue;
    if (!row.syncing && row.syncState !== 'running' && row.syncState !== 'queued') continue;
    if (!existsSync(row.jsonlPath)) {
      updateSessionMappingHealth(row.channelId, 'missing-jsonl');
      updateSessionSyncProgress(row.channelId, row.syncCheckpoint ?? 0, row.syncTotal ?? 0, 'error');
      continue;
    }
    const channel = await client.channels.fetch(row.channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) {
      updateSessionMappingHealth(row.channelId, 'stale');
      continue;
    }
    const stat = statSync(row.jsonlPath);
    const textChannel = channel as TextChannel;
    const recent = await textChannel.messages.fetch({ limit: 50 }).catch(() => null);
    let progress = recent?.find((message) =>
      message.author.id === client.user?.id &&
      /^(?:🔄 Sync transcript|🔄 Resuming transcript sync)/.test(message.content),
    ) ?? null;
    const resumeContent = `🔄 Resuming transcript sync from byte ${row.syncCheckpoint ?? 0}/${stat.size}`;
    if (progress) {
      await progress.edit({ content: resumeContent }).catch((error: unknown) => {
        if ((error as { code?: number } | null)?.code === 10008) progress = null;
      });
    }
    const progressMessage = progress ?? await textChannel.send({ content: resumeContent });
    const source: DiscoveredSession = {
      uuid: row.sessionUuid,
      cwd: row.cwd,
      path: row.jsonlPath,
      mtimeMs: stat.mtimeMs,
      createdAtMs: row.createdAt,
      bytes: stat.size,
    };
    enqueueReplay(() => runReplay(textChannel, progressMessage, source, false, row.sequenceNumber!));
    resumed++;
  }
  return resumed;
}

function formatEta(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

export async function importAllUnmappedSessions(client: Client): Promise<{ started: number; skipped: number; failed: number }> {
  let started = 0;
  let skipped = 0;
  let failed = 0;
  for (const source of discoverClaudeSessions()) {
    if (findSessionByUuid(source.uuid)) {
      skipped++;
      continue;
    }
    try {
      await createSyncedSession(client, source);
      started++;
    } catch (err) {
      failed++;
      log.warn(`cannot import session ${source.uuid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { started, skipped, failed };
}

export function sourceForSession(cwd: string, uuid: string): DiscoveredSession | null {
  return discoverClaudeSessions().find((session) => session.uuid === uuid && session.cwd === cwd) ?? null;
}
