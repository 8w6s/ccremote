import { SlashCommandBuilder, ChannelType, TextChannel } from 'discord.js';
import { Command } from '../../types';
import { config } from '../../config';
import { v2Error, v2Ok, replyV2 } from '../../lib/v2';
import { getSession, closeSession } from '../../lib/state';
import { bridge } from '../../lib/bridge';
import { renameSessionChannel, moveToArchive } from '../../lib/hub';
import { cleanupUploads, cleanupTempAttachments } from '../../lib/attachments';
import { isLiveSessionCategory } from '../../lib/sessionCategories';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close this session and archive its channel.'),
  async execute(interaction) {
    const ch = interaction.channel;
    if (!ch || ch.type !== ChannelType.GuildText) {
      await replyV2(interaction, v2Error('❌ /close only works in a session channel.'), {
        ephemeral: true,
      });
      return;
    }
    const channel = ch as TextChannel;
    if (!isLiveSessionCategory(channel.parentId, {
      active: config.categoryId,
      background: config.backgroundCategoryId,
    })) {
      await replyV2(interaction, v2Error('❌ This channel is outside the session categories.'), {
        ephemeral: true,
      });
      return;
    }
    const session = getSession(channel.id);
    if (!session) {
      await replyV2(interaction, v2Error('❌ This channel is not a Claude session.'), {
        ephemeral: true,
      });
      return;
    }
    if (session.status === 'closed') {
      await replyV2(interaction, v2Error('⚠ This session is already closed.'), { ephemeral: true });
      return;
    }

    await interaction.deferReply();
    await bridge.drop(channel.id);
    closeSession(channel.id);

    let cleaned = 0;
    try {
      cleaned = cleanupUploads(session.cwd, channel.id);
      cleaned += cleanupTempAttachments(channel.id);
      if (session.sessionUuid) cleaned += cleanupTempAttachments(session.sessionUuid);
    } catch {
      /* ignore */
    }

    await renameSessionChannel(channel, '🔒 ');
    const moved = await moveToArchive(channel);

    const parts: string[] = ['✅ Session closed'];
    if (moved) parts.push('channel moved to archive category');
    if (cleaned > 0) parts.push(`removed ${cleaned} upload files`);
    await replyV2(interaction, v2Ok(parts.join(' · ') + '.'));
  },
};

export default command;
