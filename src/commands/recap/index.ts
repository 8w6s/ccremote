import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { runNativeCommand } from '../../lib/nativeCommand';

const command: Command = {
  data: new SlashCommandBuilder().setName('recap').setDescription('Generate a short recap of this session.'),
  execute: async (i) => runNativeCommand(i, '/recap', 'recap'),
};
export default command;
