import { homedir } from 'node:os';
import { join } from 'node:path';

export function claudeExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_BIN?.trim() || 'claude';
}

/** Encode a working directory exactly as Claude Code names project folders. */
export function encodeClaudeCwd(cwd: string): string {
  return '-' + cwd.replace(/\//g, '-').replace(/^-+/, '');
}

/** Return the canonical local transcript path for one Claude session. */
export function claudeSessionJsonlPath(cwd: string, sessionUuid: string): string {
  return join(homedir(), '.claude', 'projects', encodeClaudeCwd(cwd), `${sessionUuid}.jsonl`);
}
