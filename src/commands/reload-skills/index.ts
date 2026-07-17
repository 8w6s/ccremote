import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { v2Error, v2Ok, replyV2 } from '../../lib/v2';
import { getSession } from '../../lib/state';
import { bridge } from '../../lib/bridge';
import { requireSessionChannel } from '../../lib/sessionGuard';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('reload-skills')
    .setDescription('Restart the CLI to reload recently edited skills from ~/.claude/skills/.'),
  async execute(interaction) {
    const channel = await requireSessionChannel(interaction);
    if (!channel) return;
    if (!getSession(channel.id)) {
      await replyV2(interaction, v2Error('❌ This channel is not a Claude session.'), {
        ephemeral: true,
      });
      return;
    }
    await bridge.drop(channel.id);
    await replyV2(interaction, v2Ok('✅ Runner stopped. The next prompt starts a fresh CLI with reloaded skills.'), {
      ephemeral: true,
    });
  },
};

export default command;
