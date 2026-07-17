import { createReadStream, existsSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { watch, FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Client, TextChannel, ChannelType } from 'discord.js';
import { getSession, listActiveSessions, updateSessionMirrorOffset } from './state';
import { bridge } from './bridge';
import { Renderer } from './renderer';
import { log } from './logger';
import { normalizeJsonlEvent } from './interactionEvents';

/**
 * Mirror JSONL local → Discord.
 *
 *
 * Dedup:
 */

function encodeCwd(cwd: string): string {
  return '-' + cwd.replace(/\//g, '-').replace(/^-+/, '');
}

interface WatcherEntry {
  channelId: string;
  jsonlPath: string;
  watcher: FSWatcher | null;
  offset: number;
  pending: boolean;
  pendingAgain: boolean;
  renderer: Renderer | null;
}

async function countJsonlLines(path: string, byteLimit: number): Promise<number> {
  if (byteLimit <= 0) return 0;
  const input = createReadStream(path, { start: 0, end: byteLimit - 1 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let count = 0;
  for await (const line of lines) if (line.trim()) count++;
  return count;
}

/** Yield complete JSONL records with their exact byte boundary. */
export async function* readJsonlRecords(
  path: string,
  startByte: number,
  endExclusive: number,
): AsyncGenerator<{ line: string; endOffset: number }> {
  if (startByte >= endExclusive) return;
  const stream = createReadStream(path, { start: startByte, end: endExclusive - 1 });
  let buffer = Buffer.alloc(0);
  let committed = startByte;
  for await (const raw of stream) {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(raw) ? raw : Buffer.from(raw)]);
    for (;;) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) break;
      const record = buffer.subarray(0, newline);
      const bytes = newline + 1;
      committed += bytes;
      buffer = buffer.subarray(bytes);
      const content = record.length > 0 && record[record.length - 1] === 0x0d
        ? record.subarray(0, record.length - 1)
        : record;
      yield { line: content.toString('utf8'), endOffset: committed };
    }
  }
  // JSONL writers normally terminate records with LF, but a closed snapshot
  // may contain a valid final record without it.
  if (buffer.length > 0) {
    yield { line: buffer.toString('utf8'), endOffset: endExclusive };
  }
}

class JsonlMirror {
  private client: Client | null = null;
  private entries = new Map<string, WatcherEntry>(); // channelId → entry
  private started = false;

  start(client: Client): void {
    if (this.started) return;
    this.started = true;
    this.client = client;
    for (const row of listActiveSessions()) {
      if (!row.sessionUuid) continue;
      if (row.syncing || row.syncState === 'running' || row.syncState === 'queued') continue;
      const jsonlPath = join(
        homedir(),
        '.claude',
        'projects',
        encodeCwd(row.cwd),
        `${row.sessionUuid}.jsonl`,
      );
      if (!existsSync(jsonlPath)) continue;
      void this.armWatcher(row.channelId, jsonlPath);
    }
    log.dim(`JsonlMirror: armed ${this.entries.size} watcher(s).`);
  }

  stop(): void {
    for (const entry of this.entries.values()) {
      entry.watcher?.close();
    }
    this.entries.clear();
    this.started = false;
  }

  /** Arm or replace the watcher for one channel/transcript. */
  async armWatcher(channelId: string, jsonlPath: string): Promise<void> {
    const existing = this.entries.get(channelId);
    if (existing) {
      existing.watcher?.close();
    }
    let offset = 0;
    try {
      const st = statSync(jsonlPath);
      const row = getSession(channelId);
      offset = Math.min(row?.mirrorOffset ?? row?.syncCheckpoint ?? st.size, st.size);
    } catch {
      offset = 0;
    }
    const entry: WatcherEntry = {
      channelId,
      jsonlPath,
      watcher: null,
      offset,
      pending: false,
      pendingAgain: false,
      renderer: null,
    };
    try {
      entry.watcher = watch(jsonlPath, () => {
        void this.onFileChange(entry);
      });
    } catch (err) {
      log.warn(
        `JsonlMirror: fs.watch(${jsonlPath}) fail:`,
        err instanceof Error ? err.message : err,
      );
      return;
    }
    this.entries.set(channelId, entry);
  }

  /** User `/delete` hoặc close → remove watcher. */
  removeWatcher(channelId: string): void {
    const entry = this.entries.get(channelId);
    if (!entry) return;
    entry.watcher?.close();
    this.entries.delete(channelId);
  }

  async replayFile(
    channelId: string,
    jsonlPath: string,
    onProgress?: (progress: {
      percent: number;
      checkpoint: number;
      totalBytes: number;
      eventsDone: number;
      totalEvents: number;
      etaMs: number | null;
    }) => Promise<void>,
    startByte = 0,
  ): Promise<{ rendered: number; malformed: number; checkpoint: number; totalEvents: number }> {
    if (!this.client) throw new Error('JsonlMirror has not started');
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error('Session channel does not exist');
    }
    const snapshotBytes = statSync(jsonlPath).size;
    const safeStart = Math.min(Math.max(0, startByte), snapshotBytes);
    const totalEvents = await countJsonlLines(jsonlPath, snapshotBytes);
    const eventsBefore = safeStart > 0 ? await countJsonlLines(jsonlPath, safeStart) : 0;
    if (safeStart >= snapshotBytes) {
      return { rendered: 0, malformed: 0, checkpoint: snapshotBytes, totalEvents };
    }
    const renderer = new Renderer(channel as TextChannel);
    let rendered = 0;
    let malformed = 0;
    let lastPercent = -1;
    const startedAt = Date.now();
    for await (const record of readJsonlRecords(jsonlPath, safeStart, snapshotBytes)) {
      const line = record.line;
      if (!line.trim()) continue;
      try {
        await this.renderJsonlEvent(renderer, JSON.parse(line));
        rendered++;
      } catch {
        malformed++;
      }
      const checkpoint = record.endOffset;
      const percent = snapshotBytes === 0 ? 100 : Math.min(100, Math.floor((checkpoint / snapshotBytes) * 100));
      if (onProgress) {
        lastPercent = Math.max(lastPercent, percent);
        const elapsed = Date.now() - startedAt;
        const processed = Math.max(1, checkpoint - safeStart);
        const etaMs = checkpoint < snapshotBytes
          ? Math.round((elapsed / processed) * (snapshotBytes - checkpoint))
          : 0;
        await onProgress({
          percent,
          checkpoint,
          totalBytes: snapshotBytes,
          eventsDone: eventsBefore + rendered + malformed,
          totalEvents,
          etaMs,
        });
      }
      if (rendered % 20 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    if (onProgress && lastPercent < 100) {
      await onProgress({
        percent: 100,
        checkpoint: snapshotBytes,
        totalBytes: snapshotBytes,
        eventsDone: totalEvents,
        totalEvents,
        etaMs: 0,
      });
    }
    return { rendered, malformed, checkpoint: snapshotBytes, totalEvents };
  }

  private async onFileChange(entry: WatcherEntry): Promise<void> {
    if (entry.pending) {
      entry.pendingAgain = true;
      return;
    }
    entry.pending = true;
    try {
      if (bridge.has(entry.channelId)) {
        // Runner already rendered these events from stdout. Commit the observed
        // complete file position so the mirror cannot replay them later.
        try {
          const st = statSync(entry.jsonlPath);
          entry.offset = st.size;
          updateSessionMirrorOffset(entry.channelId, entry.offset);
        } catch {
          /* ignore */
        }
        return;
      }

      let st;
      try {
        st = statSync(entry.jsonlPath);
      } catch {
        return;
      }
      if (st.size < entry.offset) {
        entry.offset = 0;
      }
      if (st.size === entry.offset) return;

      const bufSize = st.size - entry.offset;
      const fd = await open(entry.jsonlPath, 'r');
      let text: string;
      try {
        const buf = Buffer.alloc(bufSize);
        await fd.read(buf, 0, bufSize, entry.offset);
        text = buf.toString('utf-8');
      } finally {
        await fd.close();
      }
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline < 0) return;
      const complete = text.slice(0, lastNewline + 1);
      const lines = complete.split('\n').filter((l) => l.trim());
      if (lines.length === 0) {
        entry.offset += Buffer.byteLength(complete, 'utf8');
        updateSessionMirrorOffset(entry.channelId, entry.offset);
        return;
      }

      const renderer = this.getRenderer(entry);
      if (!renderer) return;

      for (const line of lines) {
        let evt: unknown;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        await this.renderJsonlEvent(renderer, evt);
      }
      entry.offset += Buffer.byteLength(complete, 'utf8');
      updateSessionMirrorOffset(entry.channelId, entry.offset);
    } catch (err) {
      log.warn(
        `JsonlMirror[${entry.channelId}] err:`,
        err instanceof Error ? err.message : err,
      );
    } finally {
      entry.pending = false;
      if (entry.pendingAgain) {
        entry.pendingAgain = false;
        queueMicrotask(() => void this.onFileChange(entry));
      }
    }
  }

  private getRenderer(entry: WatcherEntry): Renderer | null {
    if (entry.renderer) return entry.renderer;
    if (!this.client) return null;
    const row = getSession(entry.channelId);
    if (!row || row.status !== 'active') return null;
    const ch = this.client.channels.cache.get(entry.channelId);
    if (!ch || ch.type !== ChannelType.GuildText) return null;
    entry.renderer = new Renderer(ch as TextChannel);
    return entry.renderer;
  }

  /**
   * - user message (text)
   * - assistant text
   * - tool_use
   * - tool_result
   */
  private async renderJsonlEvent(renderer: Renderer, evt: unknown): Promise<void> {
    const normalized = normalizeJsonlEvent(evt);
    if (normalized.length === 0) {
      const type = evt && typeof evt === 'object' ? String((evt as Record<string, unknown>).type ?? 'unknown') : 'invalid';
      if (!['system', 'summary', 'progress', 'file-history-snapshot'].includes(type)) {
        log.dim(`JsonlMirror: ignored unrecognized event type=${type}`);
      }
      return;
    }
    for (const event of normalized) await renderer.renderEvent(event);
  }
}

export const jsonlMirror = new JsonlMirror();
