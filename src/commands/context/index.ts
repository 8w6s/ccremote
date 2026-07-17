import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { requireSessionChannel } from '../../lib/sessionGuard';
import { bridge } from '../../lib/bridge';
import { replyV2, v2Error, v2Ok } from '../../lib/v2';
import { getSession } from '../../lib/state';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('context')
    .setDescription('Show the current model context usage.'),
  async execute(interaction) {
    const channel = await requireSessionChannel(interaction);
    if (!channel) return;
    const session = getSession(channel.id);
    if (!session || session.syncing || session.readOnlyImport) {
      await replyV2(
        interaction,
        v2Error(session?.syncing
          ? '⚠ Transcript sync is still in progress.'
          : '⚠ This session cannot start a live Claude command.'),
        { ephemeral: true },
      );
      return;
    }
    const { runner, reason } = await bridge.getOrCreate(channel);
    if (!runner) {
      await replyV2(interaction, v2Error(reason ?? '❌ Runner is unavailable.'), { ephemeral: true });
      return;
    }
    await runner.push('/context all', [], interaction.user.id, { tag: 'context' });
    await replyV2(
      interaction,
      v2Ok('✅ Requested Claude Code context usage; the native breakdown will be rendered in this channel.'),
      { ephemeral: true },
    );
  },
};

export default command;
