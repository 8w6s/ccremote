import { SlashCommandBuilder } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { Command } from '../../types';
import { v2Error, v2Ok, replyV2 } from '../../lib/v2';
import { getSession, updateSessionUuid } from '../../lib/state';
import { bridge } from '../../lib/bridge';
import { requireSessionChannel } from '../../lib/sessionGuard';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('fork')
    .setDescription('Fork this session into a new Claude UUID in the same channel.'),
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
    await bridge.drop(channel.id);
    const newUuid = randomUUID();
    updateSessionUuid(channel.id, newUuid);
    await replyV2(
      interaction,
      v2Ok(`✅ Forked. New session UUID: \`${newUuid.slice(0, 8)}\`.`),
    );
  },
};

export default command;
