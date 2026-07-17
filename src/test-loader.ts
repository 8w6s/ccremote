/**
 * npm test
 */
import { Client, Collection, GatewayIntentBits } from 'discord.js';
import { Command, ExtendedClient } from './types';
import { loadCommands } from './loaders/commandLoader';
import chalk from 'chalk';

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
}) as ExtendedClient;
client.commands = new Collection<string, Command>();

const cmds = loadCommands(client);
console.log(chalk.cyan(`\nLoaded ${cmds.length} command(s):`));
for (const c of cmds) {
  console.log(`  · ${c.data.name} — ${c.data.description ?? '(no desc)'}`);
}

const seen = new Set<string>();
let dupes = 0;
for (const c of cmds) {
  if (seen.has(c.data.name)) {
    console.error(chalk.red(`✗ Duplicate: ${c.data.name}`));
    dupes++;
  }
  seen.add(c.data.name);
}
if (dupes === 0) console.log(chalk.green('✓ No duplicate command names.'));
process.exit(dupes === 0 ? 0 : 1);
