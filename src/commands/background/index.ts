import { ChannelType, SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { config } from '../../config';
import { createBackgroundSession, startBackgroundPrompt } from '../../lib/backgroundSessions';
import { getSession } from '../../lib/state';
import { v2Error, v2Ok, V2_FLAGS_EPHEMERAL } from '../../lib/v2';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('background')
    .setDescription('Start an independently steerable Claude background agent.')
    .addStringOption((option) =>
      option
        .setName('prompt')
        .setDescription('The initial task for the background agent.')
        .setMaxLength(4000)
        .setRequired(true),
    ),
  async execute(interaction) {
    if (!config.backgroundCategoryId) {
      await interaction.reply({
        components: [v2Error('BACKGROUND_CATEGORY_ID is not configured.')],
        flags: V2_FLAGS_EPHEMERAL,
      });
      return;
    }

    await interaction.deferReply({ flags: V2_FLAGS_EPHEMERAL } as never);
    const prompt = interaction.options.getString('prompt', true).trim();
    if (!prompt) {
      await interaction.editReply({ components: [v2Error('The background prompt cannot be empty.')] } as never);
      return;
    }

    const source = interaction.channel?.type === ChannelType.GuildText
      ? getSession(interaction.channel.id)
      : null;
    const cwd = source?.cwd ?? config.defaultCwd;
    const result = await createBackgroundSession(
      interaction.client,
      interaction.id,
      cwd,
    );
    if (!result) {
      await interaction.editReply({
        components: [v2Error('Unable to create the background agent channel. Check the configured category and bot permissions.')],
      } as never);
      return;
    }

    const error = await startBackgroundPrompt(result, prompt, interaction.user.id);
    if (error) {
      await interaction.editReply({
        components: [v2Error(`Created <#${result.channel.id}>, but the agent could not start: ${error}`)],
      } as never);
      return;
    }
    await interaction.editReply({
      components: [v2Ok(`Background agent started in <#${result.channel.id}>.`)],
    } as never);
  },
};

export default command;
