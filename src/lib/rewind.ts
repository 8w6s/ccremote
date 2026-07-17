import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { log } from './logger';
import { claudeSessionJsonlPath } from './claudePaths';

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
  return claudeSessionJsonlPath(cwd, sessionUuid);
}

/**
 */
export async function readUserPrompts(cwd: string, sessionUuid: string): Promise<UserPrompt[]> {
  return readUserPromptsFromPath(sessionJsonlPath(cwd, sessionUuid));
}

export async function readUserPromptsFromPath(p: string): Promise<UserPrompt[]> {
  if (!existsSync(p)) return [];
  const out: UserPrompt[] = [];
  const stream = createReadStream(p, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
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
      // Skip attachment stubs and system-injected notifications.
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
  } catch (err) {
    log.warn('readUserPrompts:', err instanceof Error ? err.message : err);
    return [];
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
