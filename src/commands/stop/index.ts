import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { v2Error, v2Ok, replyV2 } from '../../lib/v2';
import { getSession, updateBackgroundStatus } from '../../lib/state';
import { bridge } from '../../lib/bridge';
import { requireSessionChannel } from '../../lib/sessionGuard';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Abort a turn or stop a background agent while preserving its transcript.'),
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
    if (session.sessionType === 'background') {
      if (bridge.has(channel.id)) await bridge.drop(channel.id);
      updateBackgroundStatus(channel.id, 'stopped');
      await replyV2(
        interaction,
        v2Ok('⏹ Background agent is stopped. Its transcript is preserved; send a new message to resume it.'),
        { ephemeral: true },
      );
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
