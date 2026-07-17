import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { Command, ExtendedClient } from '../types';

/**
 */
export function loadCommands(client: ExtendedClient): Command[] {
  const commandsDir = join(__dirname, '..', 'commands');
  const loaded: Command[] = [];

  if (!existsSync(commandsDir)) {
    console.warn(chalk.yellow(`⚠ Commands directory is missing: ${commandsDir}`));
    return loaded;
  }

  const entries = readdirSync(commandsDir).filter((name) =>
    statSync(join(commandsDir, name)).isDirectory(),
  );

  for (const folder of entries) {
    const command = loadOne(join(commandsDir, folder), folder);
    if (!command) continue;

    if (client.commands.has(command.data.name)) {
      console.warn(
        chalk.yellow(`⚠ Duplicate command name "${command.data.name}" in ${folder}; skipping it.`),
      );
      continue;
    }
    client.commands.set(command.data.name, command);
    loaded.push(command);
  }

  console.log(
    chalk.green(
      `✓ Loaded ${loaded.length} command(s): ${loaded.map((c) => c.data.name).join(', ') || '(none)'}`,
    ),
  );
  return loaded;
}

function loadOne(folderPath: string, folderName: string): Command | null {
  const entryTs = join(folderPath, 'index.ts');
  const entryJs = join(folderPath, 'index.js');
  const entry = existsSync(entryTs) ? entryTs : existsSync(entryJs) ? entryJs : null;

  if (!entry) {
    console.warn(chalk.yellow(`⚠ Folder "${folderName}" has no index.ts/index.js; skipping it.`));
    return null;
  }

  let imported: { default?: Command } & Command;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    imported = require(entry);
  } catch (err) {
    console.warn(
      chalk.red(`✗ Command "${folderName}" threw while loading:`),
      err instanceof Error ? err.message : err,
    );
    return null;
  }
  const command: Command = imported.default ?? imported;

  if (!command?.data || typeof command.execute !== 'function') {
    console.warn(
      chalk.yellow(`⚠ Command "${folderName}" is missing data or execute; skipping it.`),
    );
    return null;
  }
  return command;
}
