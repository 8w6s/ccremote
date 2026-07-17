import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { config } from '../../config';
import { logoutClaude } from '../../lib/claudeAuth';
import { bridge } from '../../lib/bridge';
import { replyV2, v2Error, v2Ok } from '../../lib/v2';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('logout')
    .setDescription('Sign the machine-wide Claude Code CLI out.')
    .addBooleanOption((option) => option
      .setName('confirm_stop')
      .setDescription('Confirm stopping all active Claude runners before logout')
      .setRequired(false)) as unknown as SlashCommandBuilder,
  async execute(interaction) {
    if (interaction.user.id !== config.ownerId) {
      await replyV2(interaction, v2Error('Only the bot owner may change machine authentication.'), { ephemeral: true });
      return;
    }
    const activeRunners = bridge.size();
    if (activeRunners > 0 && interaction.options.getBoolean('confirm_stop') !== true) {
      await replyV2(
        interaction,
        v2Error(
          `⚠ Logout must stop ${activeRunners} active Claude runner${activeRunners === 1 ? '' : 's'}. ` +
          'Finish any in-progress turns, then rerun `/logout confirm_stop:true` to continue.',
        ),
        { ephemeral: true },
      );
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    await bridge.stopAll();
    const result = await logoutClaude();
    await replyV2(
      interaction,
      result.ok ? v2Ok('Claude Code logged out. Existing Runners were stopped.') : v2Error(result.detail),
      { ephemeral: true },
    );
  },
};

export default command;
