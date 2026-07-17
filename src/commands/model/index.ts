import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { v2Error, v2Ok, replyV2 } from '../../lib/v2';
import { getSession, updateSessionModel } from '../../lib/state';
import { bridge } from '../../lib/bridge';
import { requireSessionChannel } from '../../lib/sessionGuard';

const MODELS = [
  { name: 'sonnet (default alias)', value: 'sonnet' },
  { name: 'opus', value: 'opus' },
  { name: 'haiku', value: 'haiku' },
  { name: 'claude-sonnet-4-5', value: 'claude-sonnet-4-5' },
  { name: 'claude-opus-4-5', value: 'claude-opus-4-5' },
  { name: '(reset to default)', value: 'default' },
];

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('model')
    .setDescription('Change the model for this session.')
    .addStringOption((o) =>
      o
        .setName('name')
        .setDescription('Model name / alias')
        .setRequired(true)
        .addChoices(...MODELS),
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
    const name = interaction.options.getString('name', true);
    const modelVal = name === 'default' ? null : name;
    await interaction.deferReply();
    await bridge.drop(channel.id);
    updateSessionModel(channel.id, modelVal);
    await replyV2(
      interaction,
      v2Ok(modelVal ? `✅ Model set = \`${modelVal}\`.` : '✅ Model reset to default.'),
    );
  },
};

export default command;
