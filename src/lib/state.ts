import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Durable clauderemote session state.
 *
 * File: $XDG_STATE_HOME/clauderemote/channels.json (fallback ~/.local/state)
 * Schema: { channelId: { sessionUuid?, cwd, status, createdAt, lastActiveAt, turnCount } }
 *
 * chuẩn của Claude Code CLI ở ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl.
 * The bot stores identity and lifecycle metadata, not transcript content.
 */

export interface SessionState {
  sessionUuid: string | null;
  forkFromUuid?: string | null;
  syncing?: boolean;
  readOnlyImport?: boolean;
  loop?: { interval?: string; prompt: string; active: boolean; updatedAt: number } | null;
  goal?: {
    objective: string;
    status: 'active' | 'complete' | 'blocked';
    note?: string;
    updatedAt: number;
  } | null;
  cwd: string;
  guildId?: string;
  jsonlPath?: string | null;
  sequenceNumber?: number | null;
  source?: 'discord' | 'cli-local' | 'branch';
  syncState?: 'idle' | 'queued' | 'running' | 'paused' | 'completed' | 'error';
  syncCheckpoint?: number;
  syncTotal?: number;
  /** Last complete JSONL byte boundary rendered by the live mirror. */
  mirrorOffset?: number;
  mappingHealth?: 'healthy' | 'stale' | 'missing-jsonl' | 'duplicate';
  status: 'active' | 'closed';
  createdAt: number;
  lastActiveAt: number;
  turnCount: number;
  model?: string | null;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode' | null;
  permissionMode?: string | null;
  /**
   */
  pendingPromptAt?: number | null;
  /**
   * listActiveSessions.
   */
  channelDeleted?: boolean;
  /** Durable guard preventing channelDelete recovery during an intentional delete. */
  deleting?: boolean;
}

const STATE_DIR = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
  'clauderemote',
);
const STATE_FILE = join(STATE_DIR, 'channels.json');
const BACKUP_FILE = `${STATE_FILE}.bak`;

type Store = Record<string, SessionState>;

let cache: Store | null = null;

function parseStore(raw: string, source: string): Store {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source} does not contain an object store`);
  }
  for (const [channelId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^\d+$/.test(channelId) || !value || typeof value !== 'object') {
      throw new Error(`${source} contains an invalid channel row`);
    }
    const row = value as Partial<SessionState>;
    if (typeof row.cwd !== 'string' || !['active', 'closed'].includes(String(row.status))) {
      throw new Error(`${source} contains an invalid session row for ${channelId}`);
    }
  }
  return parsed as Store;
}

function loadStore(): Store {
  if (cache) return cache;
  if (!existsSync(STATE_FILE)) {
    cache = {};
    return cache;
  }
  try {
    const raw = readFileSync(STATE_FILE, 'utf-8');
    cache = parseStore(raw, STATE_FILE);
  } catch (primaryError) {
    if (existsSync(BACKUP_FILE)) {
      try {
        cache = parseStore(readFileSync(BACKUP_FILE, 'utf-8'), BACKUP_FILE);
        return cache;
      } catch {
        /* report the primary failure below */
      }
    }
    throw new Error(
      `Session state is unreadable; refusing to start with an empty mapping: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}`,
    );
  }
  return cache;
}

function saveStore(): void {
  if (!cache) return;
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  // Write tmp then rename → POSIX atomic replace. Crash between steps
  // leaves STATE_FILE intact (worst case: orphan tmp cleaned on next save).
  writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  if (existsSync(STATE_FILE)) copyFileSync(STATE_FILE, BACKUP_FILE);
  renameSync(tmp, STATE_FILE);
}

export function ensureStateDir(): void {
  mkdirSync(STATE_DIR, { recursive: true });
}

/** Backfill v1 channel rows without renumbering already assigned sessions. */
export function migrateSessionMetadata(
  guildId: string,
  sources: Array<{ uuid: string; path: string; bytes: number }>,
  sequenceForIdentity: (identity: string) => number,
): number {
  const store = loadStore();
  const byUuid = new Map(sources.map((source) => [source.uuid, source]));
  let changed = 0;
  for (const session of Object.values(store)) {
    const source = session.sessionUuid ? byUuid.get(session.sessionUuid) : undefined;
    if (!session.guildId) { session.guildId = guildId; changed++; }
    if (session.sequenceNumber == null) {
      const identity = session.sessionUuid ?? `legacy:${session.createdAt}:${session.cwd}`;
      session.sequenceNumber = sequenceForIdentity(identity);
      changed++;
    }
    if (session.jsonlPath == null && source) { session.jsonlPath = source.path; changed++; }
    if (!session.source) { session.source = source ? 'cli-local' : 'discord'; changed++; }
    if (!session.syncState) { session.syncState = session.syncing ? 'running' : 'idle'; changed++; }
    if (session.syncCheckpoint == null) { session.syncCheckpoint = 0; changed++; }
    if (session.syncTotal == null) { session.syncTotal = source?.bytes ?? 0; changed++; }
    if (!session.mappingHealth) {
      session.mappingHealth = session.sessionUuid && !source ? 'missing-jsonl' : 'healthy';
      changed++;
    }
  }
  if (changed) saveStore();
  return changed;
}

export function getSession(channelId: string): SessionState | null {
  const store = loadStore();
  return store[channelId] ?? null;
}

export function updateSessionMappingHealth(
  channelId: string,
  health: NonNullable<SessionState['mappingHealth']>,
): void {
  const session = loadStore()[channelId];
  if (!session) return;
  session.mappingHealth = health;
  saveStore();
}

export function listAllSessions(): Array<SessionState & { channelId: string }> {
  return Object.entries(loadStore()).map(([channelId, session]) => ({ ...session, channelId }));
}

export function insertSession(
  channelId: string,
  cwd: string,
  metadata: { guildId?: string; sequenceNumber?: number; source?: SessionState['source'] } = {},
): void {
  const store = loadStore();
  if (metadata.sequenceNumber != null) {
    const conflict = Object.entries(store).find(([, session]) =>
      session.sequenceNumber === metadata.sequenceNumber &&
      (!metadata.guildId || !session.guildId || session.guildId === metadata.guildId));
    if (conflict) throw new Error(`Sequence number is already mapped to channel ${conflict[0]}`);
  }
  const now = Date.now();
  store[channelId] = {
    sessionUuid: null,
    cwd,
    guildId: metadata.guildId,
    sequenceNumber: metadata.sequenceNumber ?? null,
    source: metadata.source ?? 'discord',
    syncState: 'idle',
    syncCheckpoint: 0,
    syncTotal: 0,
    mappingHealth: 'healthy',
    status: 'active',
    createdAt: now,
    lastActiveAt: now,
    turnCount: 0,
    model: null,
  };
  saveStore();
}

export function insertImportedSession(
  channelId: string,
  cwd: string,
  sessionUuid: string | null,
  forkFromUuid?: string | null,
  metadata: {
    guildId?: string;
    jsonlPath?: string;
    sequenceNumber?: number;
    source?: SessionState['source'];
    syncTotal?: number;
  } = {},
): void {
  const store = loadStore();
  if (sessionUuid) {
    const duplicate = Object.entries(store).find(
      ([existingChannelId, session]) =>
        existingChannelId !== channelId &&
        session.sessionUuid === sessionUuid &&
        (!metadata.guildId || !session.guildId || session.guildId === metadata.guildId),
    );
    if (duplicate) throw new Error(`Session UUID is already mapped to channel ${duplicate[0]}`);
  }
  if (metadata.sequenceNumber != null) {
    const conflict = Object.entries(store).find(([existingChannelId, session]) =>
      existingChannelId !== channelId &&
      session.sequenceNumber === metadata.sequenceNumber &&
      (!metadata.guildId || !session.guildId || session.guildId === metadata.guildId));
    if (conflict) throw new Error(`Sequence number is already mapped to channel ${conflict[0]}`);
  }
  const now = Date.now();
  store[channelId] = {
    sessionUuid,
    forkFromUuid: forkFromUuid ?? null,
    cwd,
    guildId: metadata.guildId,
    jsonlPath: metadata.jsonlPath ?? null,
    sequenceNumber: metadata.sequenceNumber ?? null,
    source: metadata.source ?? (forkFromUuid ? 'branch' : 'cli-local'),
    syncState: 'queued',
    syncCheckpoint: 0,
    syncTotal: metadata.syncTotal ?? 0,
    mappingHealth: 'healthy',
    status: 'active',
    createdAt: now,
    lastActiveAt: now,
    turnCount: 0,
    model: null,
  };
  saveStore();
}

export function clearSessionForkSource(channelId: string): void {
  const store = loadStore();
  const session = store[channelId];
  if (!session) return;
  session.forkFromUuid = null;
  saveStore();
}

export function setSessionSyncFlags(
  channelId: string,
  syncing: boolean,
  readOnlyImport: boolean,
): void {
  const session = loadStore()[channelId];
  if (!session) return;
  session.syncing = syncing;
  session.readOnlyImport = readOnlyImport;
  session.syncState = syncing ? 'running' : session.syncState;
  saveStore();
}

export function finishSessionSync(channelId: string): void {
  const session = loadStore()[channelId];
  if (!session) return;
  session.syncing = false;
  session.syncState = 'completed';
  session.syncCheckpoint = session.syncTotal ?? session.syncCheckpoint;
  saveStore();
}

export function findSessionByUuid(sessionUuid: string): (SessionState & { channelId: string }) | null {
  const found = Object.entries(loadStore()).find(([, session]) => session.sessionUuid === sessionUuid);
  return found ? { ...found[1], channelId: found[0] } : null;
}

export function updateSessionUuid(channelId: string, uuid: string): void {
  const store = loadStore();
  const s = store[channelId];
  if (!s) return;
  s.sessionUuid = uuid;
  const encoded = '-' + s.cwd.replace(/\//g, '-').replace(/^-+/, '');
  s.jsonlPath = join(homedir(), '.claude', 'projects', encoded, `${uuid}.jsonl`);
  s.mappingHealth = 'healthy';
  s.lastActiveAt = Date.now();
  saveStore();
}

export function updateSessionSyncProgress(
  channelId: string,
  checkpoint: number,
  total: number,
  state: NonNullable<SessionState['syncState']> = 'running',
): void {
  const session = loadStore()[channelId];
  if (!session) return;
  session.syncCheckpoint = Math.max(0, checkpoint);
  session.syncTotal = Math.max(0, total);
  session.syncState = state;
  session.syncing = state === 'queued' || state === 'running';
  saveStore();
}

export function updateSessionMirrorOffset(channelId: string, offset: number): void {
  const session = loadStore()[channelId];
  if (!session) return;
  session.mirrorOffset = Math.max(session.mirrorOffset ?? 0, Math.floor(offset));
  saveStore();
}

export function touchSession(channelId: string): void {
  const store = loadStore();
  const s = store[channelId];
  if (!s) return;
  s.lastActiveAt = Date.now();
  s.turnCount++;
  saveStore();
}

export function updateSessionCwd(channelId: string, cwd: string): void {
  const store = loadStore();
  const s = store[channelId];
  if (!s) return;
  s.cwd = cwd;
  s.lastActiveAt = Date.now();
  // cwd change resets Claude session UUID: JSONL lives under encoded cwd path
  s.sessionUuid = null;
  saveStore();
}

export function updateSessionModel(channelId: string, model: string | null): void {
  const store = loadStore();
  const s = store[channelId];
  if (!s) return;
  s.model = model;
  saveStore();
}

export function updateSessionEffort(
  channelId: string,
  effort: SessionState['effort'],
): void {
  const store = loadStore();
  const s = store[channelId];
  if (!s) return;
  s.effort = effort;
  saveStore();
}

export function updateSessionPermissionMode(channelId: string, mode: string | null): void {
  const store = loadStore();
  const s = store[channelId];
  if (!s) return;
  s.permissionMode = mode;
  saveStore();
}

export function updateSessionLoop(
  channelId: string,
  loop: SessionState['loop'],
): void {
  const session = loadStore()[channelId];
  if (!session) return;
  session.loop = loop;
  saveStore();
}

export function updateSessionGoal(channelId: string, goal: SessionState['goal']): void {
  const session = loadStore()[channelId];
  if (!session) return;
  session.goal = goal;
  saveStore();
}

export function closeSession(channelId: string): void {
  const store = loadStore();
  const s = store[channelId];
  if (!s) return;
  s.status = 'closed';
  s.lastActiveAt = Date.now();
  saveStore();
}

/**
 */
export function reopenSession(channelId: string): boolean {
  const store = loadStore();
  const s = store[channelId];
  if (!s) return false;
  if (s.status === 'active') return false;
  s.status = 'active';
  s.lastActiveAt = Date.now();
  s.channelDeleted = false;
  saveStore();
  return true;
}

export function markPromptPending(channelId: string): void {
  const store = loadStore();
  const s = store[channelId];
  if (!s) return;
  s.pendingPromptAt = Date.now();
  saveStore();
}

export function clearPromptPending(channelId: string): void {
  const store = loadStore();
  const s = store[channelId];
  if (!s || s.pendingPromptAt == null) return;
  s.pendingPromptAt = null;
  saveStore();
}

/**
 */
export function listPendingPrompts(maxAgeMs = 5 * 60_000): Array<{
  channelId: string;
  pendingAt: number;
  cwd: string;
}> {
  const store = loadStore();
  const cutoff = Date.now() - maxAgeMs;
  return Object.entries(store)
    .filter(([, s]) => s.pendingPromptAt != null && s.pendingPromptAt > cutoff)
    .map(([channelId, s]) => ({
      channelId,
      pendingAt: s.pendingPromptAt as number,
      cwd: s.cwd,
    }));
}

/**
 */
export function markChannelDeleted(channelId: string): SessionState | null {
  const store = loadStore();
  const s = store[channelId];
  if (!s) return null;
  s.status = 'closed';
  s.channelDeleted = true;
  s.lastActiveAt = Date.now();
  s.pendingPromptAt = null;
  saveStore();
  return s;
}

/**
 */
export function migrateSessionChannel(
  oldChannelId: string,
  newChannelId: string,
): SessionState | null {
  const store = loadStore();
  const s = store[oldChannelId];
  if (!s) return null;
  // Clear cờ soft-delete + reopen status.
  s.channelDeleted = false;
  s.status = 'active';
  s.lastActiveAt = Date.now();
  delete store[oldChannelId];
  store[newChannelId] = s;
  saveStore();
  return s;
}

/**
 */
export function deleteSession(channelId: string): SessionState | null {
  const store = loadStore();
  const s = store[channelId];
  if (!s) return null;
  delete store[channelId];
  saveStore();
  return s;
}

export function setSessionDeleting(channelId: string, deleting: boolean): void {
  const session = loadStore()[channelId];
  if (!session) return;
  session.deleting = deleting;
  session.lastActiveAt = Date.now();
  saveStore();
}

export function listActiveSessions(): Array<SessionState & { channelId: string }> {
  const store = loadStore();
  return Object.entries(store)
    .filter(([, s]) => s.status === 'active')
    .map(([channelId, s]) => ({ ...s, channelId }))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

export function listClosedSessions(): Array<SessionState & { channelId: string }> {
  const store = loadStore();
  return Object.entries(store)
    .filter(([, s]) => s.status === 'closed' && !s.channelDeleted)
    .map(([channelId, s]) => ({ ...s, channelId }))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}
