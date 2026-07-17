import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { runNativeCommand } from '../../lib/nativeCommand';

const command: Command = {
  data: new SlashCommandBuilder().setName('usage').setDescription('Show usage and cost information reported by Claude Code.'),
  execute: async (i) => runNativeCommand(i, '/usage', 'usage', 'Usage requested. Custom gateways may not report pricing.'),
};
export default command;
