import chalk from 'chalk';
import { config, validateConfig } from './config';
import { createClient } from './client';
import { ensureStateDir } from './lib/state';
import { bridge } from './lib/bridge';
import { approvalMcpServer } from './lib/approvalMcpServer';
import { loadCommands } from './loaders/commandLoader';
import { loadEvents } from './loaders/eventLoader';
import { acquireInstanceLock, releaseInstanceLock } from './lib/instanceLock';
import { log } from './lib/logger';

let shuttingDown = false;
let activeClient: import('discord.js').Client | null = null;
async function gracefulShutdown(
  signal: string,
  client: import('discord.js').Client | null,
  exitCode = 0,
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
      log.err('bridge.stopAll error:', err);
    });
    await approvalMcpServer.stop().catch((err) => {
      log.err('approvalMcpServer.stop error:', err);
    });
    if (client) {
      await client.destroy();
    }
    releaseInstanceLock();
  } catch {
    /* ignore */
  }
  process.exit(exitCode);
}

process.on('unhandledRejection', (reason) => {
  log.err('❗ Unhandled rejection:', reason);
  void gracefulShutdown('unhandled rejection', activeClient, 1);
});
process.on('uncaughtException', (err) => {
  log.err('❗ Uncaught exception:', err);
  void gracefulShutdown('uncaught exception', activeClient, 1);
});

async function main(): Promise<void> {
  console.log(chalk.bold.magenta('🟣 clauderemote'));
  validateConfig();
  ensureStateDir();
  acquireInstanceLock();

  const client = createClient();
  activeClient = client;
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
      console.error(chalk.yellow('→ Open https://discord.com/developers/applications → your application → Bot.'));
      console.error(chalk.yellow('→ Enable MESSAGE CONTENT INTENT under Privileged Gateway Intents.'));
    }
    throw err;
  }
}

main().catch((err) => {
  log.err('💥 Fatal error:', err);
  void gracefulShutdown('fatal startup error', activeClient, 1);
});
