import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const FILE = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
  'clauderemote',
  'sequences.json',
);
const BACKUP_FILE = `${FILE}.bak`;

interface Registry {
  version: 1;
  assignments: Record<string, number>;
  nextByGuild: Record<string, number>;
}

let cache: Registry | null = null;

function parseRegistry(raw: string, source: string): Registry {
  const parsed = JSON.parse(raw) as Partial<Registry>;
  if (!parsed.assignments || typeof parsed.assignments !== 'object' ||
      !parsed.nextByGuild || typeof parsed.nextByGuild !== 'object') {
    throw new Error(`${source} has an invalid schema`);
  }
  for (const [identity, sequence] of Object.entries(parsed.assignments)) {
    if (!identity.includes(':') || !Number.isInteger(sequence) || sequence < 1) {
      throw new Error(`${source} contains an invalid assignment`);
    }
  }
  for (const next of Object.values(parsed.nextByGuild)) {
    if (!Number.isInteger(next) || next < 1) throw new Error(`${source} contains an invalid counter`);
  }
  return { version: 1, assignments: parsed.assignments, nextByGuild: parsed.nextByGuild };
}

function load(): Registry {
  if (cache) return cache;
  if (!existsSync(FILE)) return (cache = { version: 1, assignments: {}, nextByGuild: {} });
  try {
    cache = parseRegistry(readFileSync(FILE, 'utf8'), FILE);
  } catch (primaryError) {
    try {
      cache = parseRegistry(readFileSync(BACKUP_FILE, 'utf8'), BACKUP_FILE);
    } catch {
      throw new Error(`Sequence registry is unreadable; refusing to renumber sessions: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}`);
    }
  }
  return cache;
}

function save(): void {
  const registry = load();
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(registry, null, 2), { mode: 0o600 });
  if (existsSync(FILE)) copyFileSync(FILE, BACKUP_FILE);
  renameSync(tmp, FILE);
}

function key(guildId: string, identity: string): string {
  return `${guildId}:${identity}`;
}

export function formatSequence(sequence: number): string {
  const left = Math.floor(Math.max(1, sequence) / 10_000);
  const right = Math.max(1, sequence) % 10_000;
  return `s-${String(left).padStart(4, '0')}-${String(right).padStart(4, '0')}`;
}

export function getSequence(guildId: string, identity: string): number | null {
  return load().assignments[key(guildId, identity)] ?? null;
}

export function allocateSequence(guildId: string, identity: string): number {
  const registry = load();
  const assignmentKey = key(guildId, identity);
  const existing = registry.assignments[assignmentKey];
  if (existing != null) return existing;
  const next = Math.max(1, registry.nextByGuild[guildId] ?? 1);
  registry.assignments[assignmentKey] = next;
  registry.nextByGuild[guildId] = next + 1;
  save();
  return next;
}

export function bootstrapSequences(
  guildId: string,
  sessions: Array<{ uuid: string; createdAtMs: number; path: string }>,
): void {
  const registry = load();
  const hasAssignments = Object.keys(registry.assignments).some((k) => k.startsWith(`${guildId}:`));
  const sorted = sortSessionsForBootstrap(sessions);
  // First bootstrap preserves historical ordering. Later discoveries only append,
  // even if an older transcript is copied onto the machine.
  if (!hasAssignments) {
    let next = 1;
    for (const session of sorted) registry.assignments[key(guildId, session.uuid)] = next++;
    registry.nextByGuild[guildId] = next;
    save();
    return;
  }
  for (const session of sorted) allocateSequence(guildId, session.uuid);
}

export function sortSessionsForBootstrap<T extends { uuid: string; createdAtMs: number; path: string }>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) =>
    a.createdAtMs - b.createdAtMs || a.uuid.localeCompare(b.uuid) || a.path.localeCompare(b.path));
}

export function resetSequenceRegistryForTests(): void {
  cache = { version: 1, assignments: {}, nextByGuild: {} };
  if (existsSync(FILE) && process.env.NODE_ENV === 'test') {
    // Tests use an isolated XDG_STATE_HOME; leaving this guarded avoids misuse.
  }
}
