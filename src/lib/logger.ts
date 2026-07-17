import chalk from 'chalk';
import { inspect } from 'node:util';
import { scrub } from './scrubber';

export function sanitizeLogValue(value: unknown): string {
  if (typeof value === 'string') return scrub(value);
  if (value instanceof Error) return scrub(value.stack || value.message);
  return scrub(inspect(value, { depth: 5, breakLength: 120 }));
}

function args(values: unknown[]): string[] {
  return values.map(sanitizeLogValue);
}

export const log = {
  info: (msg: string, ...rest: unknown[]): void => console.log(chalk.cyan('ℹ'), scrub(msg), ...args(rest)),
  ok: (msg: string, ...rest: unknown[]): void => console.log(chalk.green('✓'), scrub(msg), ...args(rest)),
  warn: (msg: string, ...rest: unknown[]): void => console.warn(chalk.yellow('⚠'), scrub(msg), ...args(rest)),
  err: (msg: string, ...rest: unknown[]): void => console.error(chalk.red('✗'), scrub(msg), ...args(rest)),
  dim: (msg: string, ...rest: unknown[]): void => console.log(chalk.gray('·'), chalk.gray(scrub(msg)), ...args(rest)),
};
