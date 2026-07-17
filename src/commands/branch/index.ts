import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { requireSessionChannel } from '../../lib/sessionGuard';
import { getSession } from '../../lib/state';
import { createSyncedSession, sourceForSession } from '../../lib/sessionSync';
import { replyV2, v2Error, v2Ok } from '../../lib/v2';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('branch')
    .setDescription('Fork the conversation into a new channel and replay its transcript.'),
  async execute(interaction) {
    const channel = await requireSessionChannel(interaction);
    if (!channel) return;
    const session = getSession(channel.id);
    if (!session?.sessionUuid) {
      await replyV2(interaction, v2Error('❌ This session has no UUID to branch.'), { ephemeral: true });
      return;
    }
    if (session.syncing) {
      await replyV2(interaction, v2Error('⚠ The source session is still syncing.'), { ephemeral: true });
      return;
    }
    const source = sourceForSession(session.cwd, session.sessionUuid);
    if (!source) {
      await replyV2(interaction, v2Error('❌ Source JSONL was not found on this machine.'), { ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const branched = await createSyncedSession(interaction.client, source, { fork: true });
      await interaction.editReply({ components: [v2Ok(`✅ Created <#${branched.id}>. Transcript is syncing in the background.`)] } as never);
    } catch (err) {
      await interaction.editReply({ components: [v2Error(`❌ Branch failed: ${err instanceof Error ? err.message : String(err)}`)] } as never);
    }
  },
};

export default command;
