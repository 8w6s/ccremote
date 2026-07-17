import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from './logger';

export interface UserPrompt {
  index: number;
  text: string;
  uuid?: string;
  timestamp?: string;
}

/**
 * `/home/foo/PROJECTS` → `-home-foo-PROJECTS`.
 */
export function sessionJsonlPath(cwd: string, sessionUuid: string): string {
  const encoded = '-' + cwd.replace(/\//g, '-').replace(/^-+/, '');
  return join(homedir(), '.claude', 'projects', encoded, `${sessionUuid}.jsonl`);
}

/**
 */
export function readUserPrompts(cwd: string, sessionUuid: string): UserPrompt[] {
  const p = sessionJsonlPath(cwd, sessionUuid);
  if (!existsSync(p)) return [];
  let raw: string;
  try {
    raw = readFileSync(p, 'utf-8');
  } catch (err) {
    log.warn('readUserPrompts:', err instanceof Error ? err.message : err);
    return [];
  }
  const out: UserPrompt[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(obj)) continue;
    if (obj.type !== 'user') continue;
    if (obj.isSidechain === true) continue;
    const msg = obj.message;
    if (!isRecord(msg)) continue;
    const content = msg.content;
    let text: string | null = null;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      const hasToolResult = content.some(
        (b) => isRecord(b) && b.type === 'tool_result',
      );
      if (hasToolResult) continue;
      for (const b of content) {
        if (isRecord(b) && b.type === 'text' && typeof b.text === 'string') {
          text = b.text;
          break;
        }
      }
    }
    if (!text) continue;
    const trimmed = text.trim();
    if (!trimmed) continue;
    // Skip attachment stub & system-injected task-notification.
    if (/^\[Image: original \d+x\d+/.test(trimmed)) continue;
    if (trimmed.startsWith('<task-notification>')) continue;
    if (trimmed.startsWith('<system-reminder>')) continue;
    out.push({
      index: out.length,
      text: trimmed,
      uuid: typeof obj.uuid === 'string' ? obj.uuid : undefined,
      timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : undefined,
    });
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
