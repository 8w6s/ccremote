import { ChannelType, ChatInputCommandInteraction, TextChannel } from 'discord.js';
import { config } from '../config';
import { v2Error, replyV2 } from './v2';

/**
 * Session channel = GuildText, parent = CATEGORY_ID.
 *
 * Return the TextChannel on success; otherwise reply ephemerally and return null.
 */
export async function requireSessionChannel(
  interaction: ChatInputCommandInteraction,
): Promise<TextChannel | null> {
  const ch = interaction.channel;
  if (!ch || ch.type !== ChannelType.GuildText) {
    await replyV2(interaction, v2Error('❌ This command only works in a session channel.'), {
      ephemeral: true,
    });
    return null;
  }
  const text = ch as TextChannel;
  if (text.parentId !== config.categoryId) {
    await replyV2(interaction, v2Error('❌ This channel is outside CATEGORY_ID.'), {
      ephemeral: true,
    });
    return null;
  }
  return text;
}
