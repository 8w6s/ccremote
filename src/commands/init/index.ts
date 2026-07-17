import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { runNativeCommand } from '../../lib/nativeCommand';

const command: Command = {
  data: new SlashCommandBuilder().setName('init').setDescription('Initialize or improve the project CLAUDE.md.'),
  execute: async (i) => runNativeCommand(i, '/init', 'init'),
};
export default command;
