import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { runNativeCommand } from '../../lib/nativeCommand';

const command: Command = {
  data: new SlashCommandBuilder().setName('doctor').setDescription('Run the Claude Code health check.'),
  execute: async (i) => runNativeCommand(i, '/doctor', 'doctor'),
};
export default command;
