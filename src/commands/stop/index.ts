import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { v2Error, v2Ok, replyV2 } from '../../lib/v2';
import { getSession } from '../../lib/state';
import { bridge } from '../../lib/bridge';
import { requireSessionChannel } from '../../lib/sessionGuard';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Abort the active turn in this session.'),
  async execute(interaction) {
    const channel = await requireSessionChannel(interaction);
    if (!channel) return;
    const session = getSession(channel.id);
    if (!session) {
      await replyV2(interaction, v2Error('❌ This channel is not a Claude session.'), {
        ephemeral: true,
      });
      return;
    }
    if (!bridge.has(channel.id)) {
      await replyV2(interaction, v2Error('⚠ No Runner is currently active.'), {
        ephemeral: true,
      });
      return;
    }
    bridge.abort(channel.id);
    await replyV2(interaction, v2Ok('⏹ Abort signal sent.'), { ephemeral: true });
  },
};

export default command;
