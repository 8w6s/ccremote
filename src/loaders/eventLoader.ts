import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { BotEvent, ExtendedClient } from '../types';
import { log } from '../lib/logger';

export function loadEvents(client: ExtendedClient): void {
  const eventsDir = join(__dirname, '..', 'events');

  if (!existsSync(eventsDir)) {
    console.log(chalk.gray('· Events directory is missing; skipping event loading.'));
    return;
  }

  const files = readdirSync(eventsDir).filter(
    (f) => (f.endsWith('.ts') || f.endsWith('.js')) && !f.endsWith('.d.ts'),
  );

  let count = 0;
  for (const file of files) {
    let imported: { default?: BotEvent } & BotEvent;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      imported = require(join(eventsDir, file));
    } catch (err) {
      log.err(`Event "${file}" threw while loading:`, err);
      continue;
    }
    const event: BotEvent = imported.default ?? imported;

    if (!event?.name || typeof event.execute !== 'function') {
      console.warn(chalk.yellow(`⚠ Event "${file}" has an invalid shape; skipping it.`));
      continue;
    }

    const handler = ((...args: unknown[]): void => {
      try {
        const ret = (event.execute as (...a: unknown[]) => unknown)(...args);
        if (ret && typeof (ret as Promise<unknown>).catch === 'function') {
          (ret as Promise<unknown>).catch((err) => log.err(`Event "${event.name}" threw:`, err));
        }
      } catch (err) {
        log.err(`Event "${event.name}" threw synchronously:`, err);
      }
    }) as (...args: unknown[]) => void;
    if (event.once) (client.once as (n: string, h: unknown) => unknown)(event.name, handler);
    else (client.on as (n: string, h: unknown) => unknown)(event.name, handler);
    count++;
  }

  console.log(chalk.green(`✓ Loaded ${count} event(s).`));
}
