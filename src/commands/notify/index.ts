import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { v2Error, v2Ok, replyV2 } from '../../lib/v2';
import { setNotify, clearNotify, getNotify } from '../../lib/notify';
import { getSession } from '../../lib/state';
import { requireSessionChannel } from '../../lib/sessionGuard';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('notify')
    .setDescription('Toggle completion notifications for turns longer than 30 seconds.')
    .addStringOption((o) =>
      o
        .setName('mode')
        .setDescription('on / off')
        .setRequired(true)
        .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
    ) as unknown as SlashCommandBuilder,
  async execute(interaction) {
    const channel = await requireSessionChannel(interaction);
    if (!channel) return;
    if (!getSession(channel.id)) {
      await replyV2(interaction, v2Error('❌ This channel is not a Claude session.'), {
        ephemeral: true,
      });
      return;
    }
    const mode = interaction.options.getString('mode', true);
    if (mode === 'on') {
      setNotify(channel.id, interaction.user.id);
      await replyV2(interaction, v2Ok(`🔔 Will notify <@${interaction.user.id}> when the turn completes (>30s).`), {
        ephemeral: true,
      });
    } else {
      clearNotify(channel.id);
      await replyV2(interaction, v2Ok('🔕 Notifications disabled for this channel.'), { ephemeral: true });
    }
    void getNotify;
  },
};

export default command;
