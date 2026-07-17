import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { v2Error, v2Ok, replyV2 } from '../../lib/v2';
import { getSession, updateSessionCwd } from '../../lib/state';
import { bridge } from '../../lib/bridge';
import { requireSessionChannel } from '../../lib/sessionGuard';
import { resolveAllowedCwd } from '../../lib/pathPolicy';

export async function changeSessionCwd(interaction: ChatInputCommandInteraction): Promise<void> {
    const channel = await requireSessionChannel(interaction);
    if (!channel) return;
    const session = getSession(channel.id);
    if (!session) {
      await replyV2(interaction, v2Error('❌ This channel is not a Claude session.'), {
        ephemeral: true,
      });
      return;
    }

    const raw = interaction.options.getString('path', true);
    const resolved = resolveAllowedCwd(raw);
    if (!resolved) {
      await replyV2(
        interaction,
        v2Error(
          `❌ Path does not exist, is not a directory, or escapes ALLOWED_CWD_PREFIXES through a symlink: \`${raw}\``,
        ),
        { ephemeral: true },
      );
      return;
    }

    await interaction.deferReply();
    await bridge.drop(channel.id);
    updateSessionCwd(channel.id, resolved);
    await replyV2(
      interaction,
      v2Ok(`✅ Working directory changed to \`${resolved}\`. The next prompt will use the new working directory.`),
    );
}

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('cwd')
    .setDescription('Change the session working directory within allowed prefixes.')
    .addStringOption((o) =>
      o.setName('path').setDescription('Absolute path').setRequired(true),
    ) as unknown as SlashCommandBuilder,
  execute: changeSessionCwd,
};

export default command;
