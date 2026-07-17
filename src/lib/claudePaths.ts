import { homedir } from 'node:os';
import { join } from 'node:path';

export function claudeExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_BIN?.trim() || 'claude';
}

/** Encode a working directory exactly as Claude Code names project folders. */
export function encodeClaudeCwd(cwd: string): string {
  // Claude Code replaces every path separator/punctuation character with a
  // dash. This also handles native Windows drive paths (for example
  // C:\\work\\repo -> C--work-repo) without relying on the host separator.
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Return the canonical local transcript path for one Claude session. */
export function claudeSessionJsonlPath(cwd: string, sessionUuid: string): string {
  return join(homedir(), '.claude', 'projects', encodeClaudeCwd(cwd), `${sessionUuid}.jsonl`);
}
