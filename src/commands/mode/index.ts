import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { v2Error, v2Ok, replyV2 } from '../../lib/v2';
import { getSession, updateSessionPermissionMode } from '../../lib/state';
import { bridge } from '../../lib/bridge';
import { requireSessionChannel } from '../../lib/sessionGuard';

// - bypassPermissions: --dangerously-skip-permissions
// - auto: --permission-mode auto (Claude classifies safe vs risky)
// manual uses the explicit approval bridge for eligible tools.
// - acceptEdits: --permission-mode acceptEdits
// - plan: --permission-mode plan
const MODES = [
  { name: 'bypassPermissions — skip permission checks', value: 'bypassPermissions' },
  { name: 'auto — Claude classifies safe and risky actions', value: 'auto' },
  { name: 'manual — ask before each protected tool', value: 'manual' },
  { name: 'acceptEdits — auto approve tool Edit/Write', value: 'acceptEdits' },
  { name: 'plan — plan without execution', value: 'plan' },
];

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('mode')
    .setDescription('Change the Claude Code permission mode for this session.')
    .addStringOption((o) =>
      o
        .setName('mode')
        .setDescription('Permission mode')
        .setRequired(true)
        .addChoices(...MODES),
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
    const mode = interaction.options.getString('mode', true);
    await interaction.deferReply();
    updateSessionPermissionMode(channel.id, mode);
    const switchTiming = await bridge.reconfigureAfterTurn(channel.id);
    let roleNote = '';
    const botMember = interaction.guild?.members.me;
    if (botMember) {
      try {
        const nickname = `${interaction.client.user.username} [${mode}]`.slice(0, 32);
        await botMember.setNickname(nickname, 'clauderemote /mode status');
        roleNote = ` Bot nickname = \`${nickname}\`; the effort role is unchanged.`;
      } catch (error) {
        roleNote = ` Unable to update bot status: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    await replyV2(
      interaction,
      v2Ok(
        `✅ Permission mode = \`${mode}\`. ` +
          (switchTiming === 'deferred'
            ? 'The active turn keeps its previous mode; the Runner will switch after it finishes.'
            : 'The next prompt will use the new mode.') +
          roleNote,
      ),
    );
  },
};

export default command;
