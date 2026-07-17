import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { importAllUnmappedSessions } from '../../lib/sessionSync';
import { v2Error, v2Ok } from '../../lib/v2';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('sync-sessions')
    .setDescription('Import all unmapped local Claude Code sessions into Discord.'),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    try {
      const result = await importAllUnmappedSessions(interaction.client);
      await interaction.editReply({
        components: [v2Ok(`✅ Queued ${result.started} session; skipped ${result.skipped} already mapped UUIDs${result.failed ? `; ${result.failed} sessions could not be created (check logs, permissions, or the 50-channel category limit)` : ''}.`)],
      } as never);
    } catch (err) {
      await interaction.editReply({
        components: [v2Error(`❌ Session sync failed: ${err instanceof Error ? err.message : String(err)}`)],
      } as never);
    }
  },
};

export default command;
