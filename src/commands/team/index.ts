import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { v2Error, v2Ok, v2Info, replyV2 } from '../../lib/v2';
import { config } from '../../config';
import { addTeamMember, removeTeamMember, listTeamMembers } from '../../lib/team';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('team')
    .setDescription('Manage the bot user allowlist.')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Add a user to the allowlist.')
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Remove a user from the allowlist.')
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('List allowlisted users.')) as unknown as SlashCommandBuilder,
  async execute(interaction) {
    // Only the owner may use manage the team.
    if (interaction.user.id !== config.ownerId) {
      await replyV2(interaction, v2Error('❌ Only the owner may use manage the team.'), { ephemeral: true });
      return;
    }
    // Runtime narrowing to subcommand accessor.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sub = (interaction.options as any).getSubcommand() as 'add' | 'remove' | 'list';

    if (sub === 'add') {
      const user = interaction.options.getUser('user', true);
      const added = addTeamMember(user.id);
      await replyV2(
        interaction,
        added ? v2Ok(`✅ Added <@${user.id}>.`) : v2Info(`⚠ <@${user.id}> is already on the team.`),
        { ephemeral: true },
      );
      return;
    }
    if (sub === 'remove') {
      const user = interaction.options.getUser('user', true);
      const removed = removeTeamMember(user.id);
      await replyV2(
        interaction,
        removed ? v2Ok(`✅ Removed <@${user.id}>.`) : v2Info(`⚠ <@${user.id}> is not on the team.`),
        { ephemeral: true },
      );
      return;
    }
    // list
    const members = listTeamMembers();
    const body =
      members.length === 0
        ? '_(empty — owner only)_'
        : members.map((id) => `• <@${id}>`).join('\n');
    await replyV2(interaction, v2Info(`## 👥 Team\n${body}`), { ephemeral: true });
  },
};

export default command;
