import chalk from 'chalk';

export const log = {
  info: (msg: string, ...args: unknown[]): void => console.log(chalk.cyan('ℹ'), msg, ...args),
  ok: (msg: string, ...args: unknown[]): void => console.log(chalk.green('✓'), msg, ...args),
  warn: (msg: string, ...args: unknown[]): void => console.warn(chalk.yellow('⚠'), msg, ...args),
  err: (msg: string, ...args: unknown[]): void => console.error(chalk.red('✗'), msg, ...args),
  dim: (msg: string, ...args: unknown[]): void => console.log(chalk.gray('·'), chalk.gray(msg), ...args),
};
