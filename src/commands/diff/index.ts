import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { runNativeCommand } from '../../lib/nativeCommand';

const command: Command = {
  data: new SlashCommandBuilder().setName('diff').setDescription('Ask Claude Code to show the current changes.'),
  execute: async (i) => runNativeCommand(i, '/diff', 'diff'),
};
export default command;
