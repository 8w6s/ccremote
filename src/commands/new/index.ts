import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { v2Ok, v2Error, V2_FLAGS_EPHEMERAL } from '../../lib/v2';
import { createSessionChannel } from '../../lib/hub';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('new')
    .setDescription('Create a new Claude session channel.'),
  async execute(interaction) {
    await interaction
      .deferReply({ flags: V2_FLAGS_EPHEMERAL } as never)
      .catch(() => {});
    const result = await createSessionChannel(interaction.client);
    if (!result) {
      await interaction
        .editReply({
          components: [v2Error('❌ Unable to create a session channel.')],
        } as unknown as Parameters<typeof interaction.editReply>[0])
        .catch(() => {});
      return;
    }
    await interaction
      .editReply({
        components: [v2Ok(`✅ Create new session: <#${result.channelId}>`)],
      } as unknown as Parameters<typeof interaction.editReply>[0])
      .catch(() => {});
  },
};

export default command;
