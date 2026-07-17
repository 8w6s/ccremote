import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { config } from '../../config';
import { saveCustomApi } from '../../lib/customApi';
import { bridge } from '../../lib/bridge';
import { replyV2, v2Error, v2Ok } from '../../lib/v2';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('customapi')
    .setDescription('Configure the machine-wide Claude Code API gateway.')
    .addStringOption((option) => option
      .setName('base_url')
      .setDescription('Anthropic-compatible API base URL')
      .setRequired(true)
      .setMaxLength(1000))
    .addStringOption((option) => option
      .setName('api_key')
      .setDescription('Secret API key; never echoed or logged')
      .setRequired(true)
      .setMaxLength(2000))
    .addStringOption((option) => option
      .setName('model_ids')
      .setDescription('opus=id,sonnet=id,haiku=id')
      .setRequired(true)
      .setMaxLength(3000)) as unknown as SlashCommandBuilder,
  async execute(interaction) {
    if (interaction.user.id !== config.ownerId) {
      await replyV2(interaction, v2Error('Only the bot owner may change API credentials.'), { ephemeral: true });
      return;
    }
    const baseUrl = interaction.options.getString('base_url', true);
    const apiKey = interaction.options.getString('api_key', true);
    const modelIds = interaction.options.getString('model_ids', true);
    try {
      const saved = saveCustomApi(baseUrl, apiKey, modelIds);
      await bridge.stopAll();
      await replyV2(
        interaction,
        v2Ok(
          `Custom API configured for \`${new URL(saved.baseUrl).host}\`. ` +
          `Aliases: opus=\`${saved.models.opus}\`, sonnet=\`${saved.models.sonnet}\`, ` +
          `haiku=\`${saved.models.haiku}\`. Existing Runners were stopped and will resume lazily.`,
        ),
        { ephemeral: true },
      );
    } catch (error) {
      await replyV2(
        interaction,
        v2Error(error instanceof Error ? error.message : String(error)),
        { ephemeral: true },
      );
    }
  },
};

export default command;
