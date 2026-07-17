import chalk from 'chalk';
import { config, validateConfig } from './config';
import { createClient } from './client';
import { ensureStateDir } from './lib/state';
import { bridge } from './lib/bridge';
import { approvalMcpServer } from './lib/approvalMcpServer';
import { loadCommands } from './loaders/commandLoader';
import { loadEvents } from './loaders/eventLoader';
import { acquireInstanceLock, releaseInstanceLock } from './lib/instanceLock';

process.on('unhandledRejection', (reason) => {
  console.error(chalk.red('❗ Unhandled rejection:'), reason);
});
process.on('uncaughtException', (err) => {
  console.error(chalk.red('❗ Uncaught exception:'), err);
});

let shuttingDown = false;
async function gracefulShutdown(
  signal: string,
  client: import('discord.js').Client | null,
): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(chalk.yellow(`\n⚙ Received ${signal}; shutting down gracefully...`));

  const forceExit = setTimeout(() => {
    console.error(chalk.red('⚠  Shutdown timeout — force exit'));
    process.exit(1);
  }, 5000);
  forceExit.unref();

  try {
    await bridge.stopAll().catch((err) => {
      console.error(chalk.red('bridge.stopAll error:'), err);
    });
    await approvalMcpServer.stop().catch((err) => {
      console.error(chalk.red('approvalMcpServer.stop error:'), err);
    });
    if (client) {
      await client.destroy();
    }
    releaseInstanceLock();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

async function main(): Promise<void> {
  console.log(chalk.bold.magenta('🟣 clauderemote'));
  validateConfig();
  ensureStateDir();
  acquireInstanceLock();

  const client = createClient();
  loadCommands(client);
  loadEvents(client);

  process.on('SIGINT', () => void gracefulShutdown('SIGINT', client));
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM', client));

  try {
    await client.login(config.botToken);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes('disallowed intents')) {
      console.error(chalk.red('❌ Discord rejected login because required privileged intents are disabled.'));
      console.error(chalk.yellow('→ Mở https://discord.com/developers/applications → Bot của bạn → Bot'));
      console.error(chalk.yellow('→ Bật "MESSAGE CONTENT INTENT" ở Privileged Gateway Intents.'));
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(chalk.red('💥 Fatal error:'), err);
  process.exit(1);
});
