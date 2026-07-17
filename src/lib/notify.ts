import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const NOTIFY_FILE = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
  'clauderemote',
  'notify.json',
);

/**
 */
interface Store {
  [channelId: string]: string;
}

let cache: Store | null = null;

function load(): Store {
  if (cache) return cache;
  if (!existsSync(NOTIFY_FILE)) {
    cache = {};
    return cache;
  }
  try {
    const raw = readFileSync(NOTIFY_FILE, 'utf-8');
    const p = JSON.parse(raw) as Store;
    cache = p && typeof p === 'object' ? p : {};
  } catch {
    cache = {};
  }
  return cache;
}

function save(): void {
  if (!cache) return;
  mkdirSync(dirname(NOTIFY_FILE), { recursive: true });
  const tmp = NOTIFY_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  renameSync(tmp, NOTIFY_FILE);
}

export function setNotify(channelId: string, userId: string): void {
  const s = load();
  s[channelId] = userId;
  save();
}

export function clearNotify(channelId: string): void {
  const s = load();
  delete s[channelId];
  save();
}

export function getNotify(channelId: string): string | null {
  return load()[channelId] ?? null;
}
