/**
 * Supports an immediate force-flush at end of turn.
 *
 */
import { log } from './logger';

export class Coalescer {
  private timer: NodeJS.Timeout | null = null;
  private pending = false;
  private firing = false;
  private firePromise: Promise<void> | null = null;
  private lastFireAt = 0;

  constructor(
    private readonly minMs: number,
    private readonly fn: () => Promise<void> | void,
  ) {}

  schedule(): void {
    this.pending = true;
    if (this.timer || this.firing) return;

    const elapsed = Date.now() - this.lastFireAt;
    const wait = Math.max(0, this.minMs - elapsed);

    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pending) void this.doFire();
    }, wait);
  }

  /**
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.firePromise) {
      try { await this.firePromise; } catch { /* logged by doFire */ }
    }
    if (this.pending) await this.doFire();
  }

  private async doFire(): Promise<void> {
    if (this.firePromise) {
      try { await this.firePromise; } catch { /* ignore */ }
      return;
    }
    this.pending = false;
    this.firing = true;
    this.lastFireAt = Date.now();
    this.firePromise = (async () => {
      try {
        await this.fn();
      } catch (err) {
        log.err('Coalescer flush error:', err);
      }
    })();
    try {
      await this.firePromise;
    } finally {
      this.firing = false;
      this.firePromise = null;
      if (this.pending && !this.timer) {
        const elapsed = Date.now() - this.lastFireAt;
        const wait = Math.max(0, this.minMs - elapsed);
        this.timer = setTimeout(() => {
          this.timer = null;
          if (this.pending) void this.doFire();
        }, wait);
      }
    }
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = false;
  }
}
