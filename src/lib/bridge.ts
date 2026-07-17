import { Runner } from './runner';
import { SessionChannel } from './renderer';
import { getSession } from './state';
import { log } from './logger';

/**
 */
const CRASH_WINDOW_MS = 60_000;
const CRASH_THRESHOLD = 3;
const CRASH_COOLDOWN_MS = 120_000;

class Bridge {
  private runners = new Map<string, Runner>();
  private starting = new Map<string, Promise<{ runner: Runner | null; reason?: string }>>();
  private budgetBuckets = new Map<string, number[]>(); // channelId → timestamps (ms)
  private crashTimestamps = new Map<string, number[]>(); // channelId → recent spawn-fail times
  private cooldownUntil = new Map<string, number>(); // channelId → epoch ms

  /**
   */
  async getOrCreate(channel: SessionChannel): Promise<{ runner: Runner | null; reason?: string }> {
    const existing = this.runners.get(channel.id);
    if (existing) {
      if (!existing.isAlive()) {
        this.runners.delete(channel.id);
      } else {
        return { runner: existing };
      }
    }

    const pending = this.starting.get(channel.id);
    if (pending) return pending;

    const startPromise = this.createRunner(channel);
    this.starting.set(channel.id, startPromise);
    try {
      return await startPromise;
    } finally {
      this.starting.delete(channel.id);
    }
  }

  private async createRunner(
    channel: SessionChannel,
  ): Promise<{ runner: Runner | null; reason?: string }> {

    const cooldown = this.cooldownUntil.get(channel.id) ?? 0;
    const now = Date.now();
    if (cooldown > now) {
      const secs = Math.ceil((cooldown - now) / 1000);
      return {
        runner: null,
        reason: `Runner crashed repeatedly; retry after the ${secs}s cooldown and check service logs.`,
      };
    }

    const row = getSession(channel.id);
    if (!row) {
      log.warn(`Bridge: session state not found for ${channel.id}`);
      return { runner: null };
    }
    if (row.status !== 'active') {
      log.dim(`Bridge: session ${channel.id} is closed; skipping Runner creation.`);
      return { runner: null };
    }
    if (row.mappingHealth === 'duplicate') {
      return { runner: null, reason: 'Duplicate Claude session mapping detected. Resolve the mapping before starting a Runner.' };
    }
    if (row.deleting) {
      return { runner: null, reason: 'This session has an incomplete deletion operation. Retry /delete to finish it.' };
    }

    let runner: Runner;
    try {
      runner = new Runner(channel, {
        onExit: (_channelId, crashed) => {
          if (crashed) this.recordCrash(channel.id);
          else this.forget(channel.id);
        },
      });
      await runner.start();
    } catch (err) {
      log.err(`Bridge: Runner constructor threw:`, err instanceof Error ? err.message : err);
      this.recordCrash(channel.id);
      return { runner: null };
    }
    if (!runner.isAlive()) {
      this.recordCrash(channel.id);
      return { runner: null };
    }
    this.runners.set(channel.id, runner);
    return { runner };
  }

  /** Remove a failed child from the bridge and record its crash window. */
  private recordCrash(channelId: string): void {
    this.runners.delete(channelId);
    this.budgetBuckets.delete(channelId);
    const now = Date.now();
    const arr = (this.crashTimestamps.get(channelId) ?? []).filter(
      (t) => t > now - CRASH_WINDOW_MS,
    );
    arr.push(now);
    this.crashTimestamps.set(channelId, arr);
    if (arr.length >= CRASH_THRESHOLD) {
      const until = now + CRASH_COOLDOWN_MS;
      this.cooldownUntil.set(channelId, until);
      this.crashTimestamps.delete(channelId);
      log.warn(
        `Bridge[${channelId}] crashed ${arr.length} times in ${CRASH_WINDOW_MS / 1000}s; cooldown ${CRASH_COOLDOWN_MS / 1000}s.`,
      );
    }
  }

  forget(channelId: string): void {
    this.runners.delete(channelId);
    this.budgetBuckets.delete(channelId);
  }

  async drop(channelId: string, interrupt = true): Promise<void> {
    const pending = this.starting.get(channelId);
    if (pending) await pending.catch(() => {});
    const r = this.runners.get(channelId);
    this.runners.delete(channelId);
    this.budgetBuckets.delete(channelId);
    if (!r) return;
    // Mark an intentional abort so reconfiguration during a turn
    if (interrupt) r.abort();
    await r.stop();
  }

  /**
   */
  async reconfigureAfterTurn(channelId: string): Promise<'deferred' | 'stopped'> {
    const r = this.runners.get(channelId);
    if (!r) return 'stopped';
    if (r.isTurnActive()) {
      r.afterCurrentTurn(() => {
        void this.drop(channelId, false);
      });
      return 'deferred';
    }
    await this.drop(channelId, false);
    return 'stopped';
  }

  has(channelId: string): boolean {
    // A Runner can emit stdout and write JSONL before start() resolves and the
    // instance moves into `runners`. Treat that startup window as live-owned so
    // JsonlMirror cannot render the same turn through a second Renderer.
    return this.runners.has(channelId) || this.starting.has(channelId);
  }

  getRunnerForChannel(channelId: string): Runner | undefined {
    return this.runners.get(channelId);
  }

  size(): number {
    return this.runners.size;
  }

  abort(channelId: string): void {
    this.runners.get(channelId)?.abort();
  }

  /**
   */
  checkRateLimit(channelId: string, maxPerHour: number): boolean {
    const now = Date.now();
    const cutoff = now - 3600_000;
    const bucket = (this.budgetBuckets.get(channelId) ?? []).filter((t) => t > cutoff);
    if (bucket.length >= maxPerHour) {
      this.budgetBuckets.set(channelId, bucket);
      return false;
    }
    bucket.push(now);
    this.budgetBuckets.set(channelId, bucket);
    return true;
  }

  async stopAll(): Promise<void> {
    const ids = [...this.runners.keys()];
    for (const id of ids) {
      await this.drop(id);
    }
  }
}

export const bridge = new Bridge();
