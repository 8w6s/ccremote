import { SlashCommandBuilder, PermissionsBitField } from 'discord.js';
import { Command } from '../../types';
import { v2Error, v2Ok, replyV2 } from '../../lib/v2';
import { config } from '../../config';
import { getSession } from '../../lib/state';
import { requireSessionChannel } from '../../lib/sessionGuard';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('handoff')
    .setDescription('Grant another user access to this session channel.')
    .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)) as unknown as SlashCommandBuilder,
  async execute(interaction) {
    if (interaction.user.id !== config.ownerId) {
      await replyV2(interaction, v2Error('❌ Only the owner may use /handoff.'), { ephemeral: true });
      return;
    }
    const channel = await requireSessionChannel(interaction);
    if (!channel) return;
    if (!getSession(channel.id)) {
      await replyV2(interaction, v2Error('❌ This channel is not a Claude session.'), {
        ephemeral: true,
      });
      return;
    }
    const user = interaction.options.getUser('user', true);
    try {
      await channel.permissionOverwrites.edit(user.id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      } as unknown as Partial<Record<keyof typeof PermissionsBitField.Flags, boolean>>);
      await replyV2(interaction, v2Ok(`✅ Granted access to <@${user.id}>in this channel.`), {
        ephemeral: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await replyV2(interaction, v2Error(`❌ Grant failed: \`${msg}\``), { ephemeral: true });
    }
  },
};

export default command;
