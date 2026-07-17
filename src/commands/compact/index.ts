import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { runNativeCommand } from '../../lib/nativeCommand';

const command: Command = {
  data: new SlashCommandBuilder().setName('compact').setDescription('Compact the current context with optional focus instructions.')
    .addStringOption((o) => o.setName('focus').setDescription('What the summary should preserve')),
  execute: async (i) => runNativeCommand(i, `/compact${i.options.getString('focus') ? ` ${i.options.getString('focus')}` : ''}`, 'compact'),
};
export default command;
