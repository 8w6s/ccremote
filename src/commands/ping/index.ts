import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { v2Ok, replyV2 } from '../../lib/v2';

const command: Command = {
  data: new SlashCommandBuilder().setName('ping').setDescription('Sanity check.'),
  async execute(interaction) {
    await replyV2(interaction, v2Ok(`🏓 Pong · ${interaction.client.ws.ping}ms`), {
      ephemeral: true,
    });
  },
};

export default command;
