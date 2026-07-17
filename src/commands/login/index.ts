import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { config } from '../../config';
import { startClaudeLogin, submitClaudeLoginCode } from '../../lib/claudeAuth';
import { replyV2, v2Error, v2Info, v2Ok } from '../../lib/v2';
import { bridge } from '../../lib/bridge';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('login')
    .setDescription('Authenticate the machine-wide Claude Code CLI account.')
    .addStringOption((option) => option
      .setName('code')
      .setDescription('OAuth code shown by the browser, when requested')
      .setRequired(false)
      .setMaxLength(2000)) as unknown as SlashCommandBuilder,
  async execute(interaction) {
    if (interaction.user.id !== config.ownerId) {
      await replyV2(interaction, v2Error('Only the bot owner may change machine authentication.'), { ephemeral: true });
      return;
    }
    const code = interaction.options.getString('code')?.trim();
    if (code) {
      const accepted = submitClaudeLoginCode(code);
      await replyV2(
        interaction,
        accepted ? v2Ok('Login code submitted to Claude Code.') : v2Error('No active login flow is waiting for a code.'),
        { ephemeral: true },
      );
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    await bridge.stopAll();
    const login = await startClaudeLogin();
    await replyV2(
      interaction,
      login.url
        ? v2Info(`## Claude Code login\nOpen this private OAuth URL:\n${login.url}\n\nIf the browser displays a code, run \`/login code:<value>\`.`)
        : v2Info('Claude Code login started, but no URL was emitted within 15 seconds. Check whether authentication completed automatically; otherwise retry.'),
      { ephemeral: true },
    );
  },
};

export default command;
