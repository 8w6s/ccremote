import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { replyV2, v2Panel } from '../../lib/v2';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('credit')
    .setDescription('Show ccRemote project authorship and repository information.'),
  async execute(interaction) {
    await replyV2(
      interaction,
      v2Panel({
        title: 'ccRemote',
        body:
          'A self-hosted Discord control plane and transcript mirror for Claude Code.\n\n' +
          '**Creator and maintainer:** `8w6s`\n' +
          '**Repository:** [8w6s/ccremote](https://github.com/8w6s/ccremote)\n' +
          '**License:** MIT',
        footer: 'ccRemote is an independent project and is not affiliated with Anthropic.',
      }),
      { ephemeral: true },
    );
  },
};

export default command;
