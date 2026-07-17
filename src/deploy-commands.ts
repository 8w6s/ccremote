import { REST, Routes } from 'discord.js';
import chalk from 'chalk';
import { config, validateConfig } from './config';
import { createClient } from './client';
import { loadCommands } from './loaders/commandLoader';

/**
 * Chạy: npm run deploy
 */
async function main(): Promise<void> {
  validateConfig();

  const client = createClient();
  const commands = loadCommands(client);
  const body = commands.map((c) => c.data.toJSON());

  const rest = new REST({ version: '10' }).setToken(config.botToken);
  console.log(chalk.cyan(`↑ Registering ${body.length} slash command(s) in guild ${config.guildId}...`));

  const result = await rest.put(
    Routes.applicationGuildCommands(config.clientId, config.guildId),
    { body },
  );
  const arr = Array.isArray(result) ? result : [];
  console.log(chalk.green(`✓ Registered ${arr.length} command(s).`));
}

main().catch((err) => {
  console.error(chalk.red('✗ Deploy fail:'), err);
  process.exit(1);
});
