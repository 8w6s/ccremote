import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { runNativeCommand } from '../../lib/nativeCommand';
import { getSession, updateSessionRecap } from '../../lib/state';
import { requireSessionChannel } from '../../lib/sessionGuard';
import { bridge } from '../../lib/bridge';
import { replyV2, v2Error, v2Ok } from '../../lib/v2';

const ACTIONS = [
  { name: 'Generate now', value: 'now' },
  { name: 'Enable automatic recap', value: 'on' },
  { name: 'Disable automatic recap', value: 'off' },
  { name: 'Show automatic recap status', value: 'status' },
] as const;

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('recap')
    .setDescription('Generate a recap or control automatic session recaps.')
    .addStringOption((option) =>
      option
        .setName('action')
        .setDescription('Defaults to generating a recap now.')
        .setRequired(false)
        .addChoices(...ACTIONS),
    ),
  execute: async (interaction) => {
    const action = interaction.options.getString('action') ?? 'now';
    if (action === 'now') {
      await runNativeCommand(interaction, '/recap', 'recap');
      return;
    }

    const channel = await requireSessionChannel(interaction);
    if (!channel) return;
    const session = getSession(channel.id);
    if (!session) {
      await replyV2(
        interaction,
        v2Error('This channel is not mapped to a Claude session.'),
        { ephemeral: true },
      );
      return;
    }
    if (action === 'status') {
      const state = session.recap?.enabled ? 'enabled' : 'disabled';
      const last = session.recap?.lastGeneratedAt
        ? ` Last generated <t:${Math.floor(session.recap.lastGeneratedAt / 1000)}:R>.`
        : ' No automatic recap has been generated yet.';
      await replyV2(interaction, v2Ok(`Automatic session recap is **${state}**.${last}`), { ephemeral: true });
      return;
    }

    const enabled = action === 'on';
    updateSessionRecap(channel.id, enabled);
    bridge.getRunnerForChannel(channel.id)?.setAutomaticRecapEnabled(enabled);
    await replyV2(
      interaction,
      v2Ok(enabled
        ? 'Automatic session recap is enabled. After at least three turns, an idle session is recapped after three minutes.'
        : 'Automatic session recap is disabled.'),
      { ephemeral: true },
    );
  },
};
export default command;
