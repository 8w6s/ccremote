import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { bridge } from '../../lib/bridge';
import {
  EFFORT_LEVELS,
  EffortLevel,
  EFFORT_PRESETS,
  syncEffortRole,
} from '../../lib/effort';
import { getSession, updateSessionEffort } from '../../lib/state';
import { requireSessionChannel } from '../../lib/sessionGuard';
import { replyV2, v2Error, v2Ok } from '../../lib/v2';

const choices = [
  ...EFFORT_LEVELS.map((level) => ({
    name: EFFORT_PRESETS[level].label,
    value: level,
  })),
  { name: 'Auto · model default', value: 'auto' },
];

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('effort')
    .setDescription('Change reasoning effort and the bot status role.')
    .addStringOption((option) =>
      option
        .setName('level')
        .setDescription('Effort level')
        .setRequired(true)
        .addChoices(...choices),
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

    const raw = interaction.options.getString('level', true);
    const level = raw === 'auto' ? null : (raw as EffortLevel);
    if (level && !EFFORT_LEVELS.includes(level)) {
      await replyV2(interaction, v2Error('❌ Invalid effort level.'), { ephemeral: true });
      return;
    }

    await interaction.deferReply();
    const switchTiming = await bridge.reconfigureAfterTurn(
      channel.id,
      () => updateSessionEffort(channel.id, level),
    );

    let roleNote = '';
    const botMember = interaction.guild?.members.me;
    if (botMember) {
      try {
        await syncEffortRole(
          botMember,
          level,
          session.permissionMode ?? 'bypassPermissions',
        );
        roleNote = ' Bot effort role synchronized.';
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        roleNote = ` Unable to update the role: ${detail}`;
      }
    }

    const description = level
      ? `✅ Effort = \`${level}\`.${level === 'ultracode' ? ' Composite preset: native `max` + `ultrathink`.' : ''}${roleNote}`
      : `✅ Effort reset to the model default.${roleNote}`;
    await replyV2(
      interaction,
      v2Ok(description + (switchTiming === 'deferred' ? ' The active turn keeps its previous effort.' : '')),
    );
  },
};

export default command;
