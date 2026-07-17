import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const TEAM_FILE = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
  'clauderemote',
  'team.json',
);

interface Team {
  members: string[]; // user IDs
}

let cache: Team | null = null;

function load(): Team {
  if (cache) return cache;
  if (!existsSync(TEAM_FILE)) {
    cache = { members: [] };
    return cache;
  }
  try {
    const raw = readFileSync(TEAM_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Team;
    cache = parsed && Array.isArray(parsed.members) ? parsed : { members: [] };
  } catch {
    cache = { members: [] };
  }
  return cache;
}

function save(): void {
  if (!cache) return;
  mkdirSync(dirname(TEAM_FILE), { recursive: true });
  const tmp = TEAM_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  renameSync(tmp, TEAM_FILE);
}

export function isTeamMember(userId: string): boolean {
  return load().members.includes(userId);
}

export function addTeamMember(userId: string): boolean {
  const t = load();
  if (t.members.includes(userId)) return false;
  t.members.push(userId);
  save();
  return true;
}

export function removeTeamMember(userId: string): boolean {
  const t = load();
  const idx = t.members.indexOf(userId);
  if (idx < 0) return false;
  t.members.splice(idx, 1);
  save();
  return true;
}

export function listTeamMembers(): string[] {
  return [...load().members];
}
