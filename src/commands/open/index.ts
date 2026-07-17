import { ChannelType, SlashCommandBuilder, TextChannel } from 'discord.js';
import { Command } from '../../types';
import { config } from '../../config';
import { getSession, reopenSession, updateSessionType } from '../../lib/state';
import { moveToActive, renameSessionChannel } from '../../lib/hub';
import { replyV2, v2Error, v2Info, v2Ok } from '../../lib/v2';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('open')
    .setDescription('Reopen a closed session and move it to the active category.'),
  async execute(interaction) {
    const ch = interaction.channel;
    if (!ch || ch.type !== ChannelType.GuildText) {
      await replyV2(interaction, v2Error('❌ /open only works in a session channel.'), {
        ephemeral: true,
      });
      return;
    }
    const channel = ch as TextChannel;
    if (
      channel.parentId !== config.categoryId &&
      channel.parentId !== config.backgroundCategoryId &&
      channel.parentId !== config.archiveCategoryId
    ) {
      await replyV2(interaction, v2Error('❌ This channel is outside the active and archive categories.'), {
        ephemeral: true,
      });
      return;
    }
    const session = getSession(channel.id);
    if (!session) {
      await replyV2(interaction, v2Error('❌ This channel has no session state.'), {
        ephemeral: true,
      });
      return;
    }
    if (session.status === 'active' && channel.parentId === config.categoryId) {
      await replyV2(interaction, v2Info('ℹ️ This session is already open.'), { ephemeral: true });
      return;
    }

    await interaction.deferReply();
    const moved = await moveToActive(channel);
    if (!moved) {
      await replyV2(interaction, v2Error('❌ Unable to move the channel to the active category.'));
      return;
    }
    reopenSession(channel.id);
    updateSessionType(channel.id, 'foreground');
    await renameSessionChannel(channel, '');
    await replyV2(
      interaction,
      v2Ok('🔓 Session reopened. The next message will resume Claude Code.'),
    );
  },
};

export default command;
