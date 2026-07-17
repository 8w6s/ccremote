import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { v2Error, v2Ok, replyV2 } from '../../lib/v2';
import { getSession } from '../../lib/state';
import { bridge } from '../../lib/bridge';
import { requireSessionChannel } from '../../lib/sessionGuard';

const BTW_ACCENT = 0xffcc66;

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('btw')
    .setDescription('Ask a quick aside highlighted in yellow.')
    .addStringOption((o) =>
      o.setName('text').setDescription('Quick question').setRequired(true),
    ) as unknown as SlashCommandBuilder,
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
    const text = interaction.options.getString('text', true).trim();
    if (!text) {
      await replyV2(interaction, v2Error('❌ Prompt cannot be empty.'), { ephemeral: true });
      return;
    }
    const { runner, reason } = await bridge.getOrCreate(channel);
    if (!runner) {
      await replyV2(interaction, v2Error(reason ?? '❌ Unable to start the Runner.'), {
        ephemeral: true,
      });
      return;
    }
    await runner.push(text, [], interaction.user.id, {
      accentColor: BTW_ACCENT,
      tag: '💡 BTW',
    });
    await replyV2(interaction, v2Ok('💡 BTW sent.'), { ephemeral: true });
  },
};

export default command;
