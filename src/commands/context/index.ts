import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { config } from '../../config';
import { requireSessionChannel } from '../../lib/sessionGuard';
import { bridge } from '../../lib/bridge';
import { replyV2, v2Error, v2Ok } from '../../lib/v2';

function isOfficialAnthropicEndpoint(): boolean {
  if (!config.anthropicBaseUrl) return true;
  try {
    return new URL(config.anthropicBaseUrl).hostname === 'api.anthropic.com';
  } catch {
    return false;
  }
}

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('context')
    .setDescription('Show context usage on the official Anthropic API.'),
  async execute(interaction) {
    const channel = await requireSessionChannel(interaction);
    if (!channel) return;
    if (!isOfficialAnthropicEndpoint()) {
      await replyV2(
        interaction,
        v2Error('⚠ `/context all` is only supported with `api.anthropic.com`. Custom ANTHROPIC_BASE_URL does not provide a reliable breakdown.'),
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
    await replyV2(interaction, v2Ok('✅ Requested Claude Code to show `/context all`in this channel.'), { ephemeral: true });
  },
};

export default command;
