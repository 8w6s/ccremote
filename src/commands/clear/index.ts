import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { runNativeCommand } from '../../lib/nativeCommand';
import { replyV2, v2Error } from '../../lib/v2';

const command: Command = {
  data: new SlashCommandBuilder().setName('clear').setDescription('Start with empty context while preserving the old transcript.')
    .addBooleanOption((o) => o.setName('confirm').setDescription('Confirm clearing the current context').setRequired(true)),
  async execute(i) {
    if (!i.options.getBoolean('confirm', true)) {
      await replyV2(i, v2Error('Cancelled. `/clear` preserves JSONL but discards the active context.'), { ephemeral: true });
      return;
    }
    await runNativeCommand(i, '/clear', 'clear', 'Claude Code was asked to start with empty context; the old transcript remains on disk.');
  },
};
export default command;
