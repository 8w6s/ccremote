import { SlashCommandBuilder, ChannelType, TextChannel } from 'discord.js';
import { Command } from '../../types';
import { v2Error, v2Ok, replyV2 } from '../../lib/v2';
import { getSession } from '../../lib/state';
import { log } from '../../lib/logger';

/**
 */
function sanitizeChannelName(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-_🟣🟢🟡🟠🔴🔵🟤⚫⚪🔒]/gi, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('rename')
    .setDescription('Rename this session channel; Discord limits renames.')
    .addStringOption((o) =>
      o
        .setName('name')
        .setDescription('New lowercase name; spaces become dashes')
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(90),
    ) as unknown as SlashCommandBuilder,
  async execute(interaction) {
    const ch = interaction.channel;
    if (!ch || ch.type !== ChannelType.GuildText) {
      await replyV2(interaction, v2Error('❌ /rename only works in a session channel.'), {
        ephemeral: true,
      });
      return;
    }
    const channel = ch as TextChannel;
    const session = getSession(channel.id);
    if (!session) {
      await replyV2(interaction, v2Error('❌ This channel is not a Claude session.'), {
        ephemeral: true,
      });
      return;
    }
    const raw = interaction.options.getString('name', true);
    const sanitized = sanitizeChannelName(raw);
    if (!sanitized) {
      await replyV2(
        interaction,
        v2Error(
          '❌ The sanitized name is empty. Use lowercase letters, numbers, dashes, or underscores.',
        ),
        { ephemeral: true },
      );
      return;
    }
    if (sanitized === channel.name) {
      await replyV2(interaction, v2Error('⚠ The new name matches the current name.'), { ephemeral: true });
      return;
    }
    try {
      await channel.setName(sanitized);
      await replyV2(
        interaction,
        v2Ok(`✏ Channel renamed → \`${sanitized}\`.`),
      );
    } catch (err) {
      log.warn(
        '/rename: setName failed:',
        err instanceof Error ? err.message : err,
      );
      await replyV2(
        interaction,
        v2Error(
          `❌ Rename failed: ${err instanceof Error ? err.message : String(err)}\n-# Discord limits channel renames to twice per 10 minutes.`,
        ),
        { ephemeral: true },
      );
    }
  },
};

export default command;
