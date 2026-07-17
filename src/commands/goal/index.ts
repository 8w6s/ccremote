import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { bridge } from '../../lib/bridge';
import { getSession, updateSessionGoal } from '../../lib/state';
import { requireSessionChannel } from '../../lib/sessionGuard';
import { replyV2, v2Error, v2Info, v2Ok } from '../../lib/v2';

const command: Command = {
  data: new SlashCommandBuilder().setName('goal').setDescription('Manage a persistent goal across turns.')
    .addSubcommand((s) => s.setName('set').setDescription('Set a new goal.')
      .addStringOption((o) => o.setName('objective').setDescription('A concrete completion condition').setRequired(true).setMaxLength(1000)))
    .addSubcommand((s) => s.setName('status').setDescription('Show the current goal.'))
    .addSubcommand((s) => s.setName('complete').setDescription('Mark the goal complete.').addStringOption((o) => o.setName('note').setDescription('Completion result').setMaxLength(500)))
    .addSubcommand((s) => s.setName('blocked').setDescription('Mark the goal blocked.').addStringOption((o) => o.setName('reason').setDescription('Blocking reason').setRequired(true).setMaxLength(500)))
    .addSubcommand((s) => s.setName('clear').setDescription('Clear the session goal.')) as unknown as SlashCommandBuilder,
  async execute(i) {
    const channel = await requireSessionChannel(i);
    if (!channel) return;
    const session = getSession(channel.id);
    if (!session) return;
    const action = i.options.getSubcommand();
    if (action === 'status') {
      const goal = session.goal;
      await replyV2(i, v2Info(goal
        ? `## 🎯 Goal · ${goal.status}\n${goal.objective}${goal.note ? `\n\n**Note:** ${goal.note}` : ''}\n-# Updated <t:${Math.floor(goal.updatedAt / 1000)}:R>`
        : '## 🎯 Goal\nThis session has no goal.'), { ephemeral: true });
      return;
    }
    if (action === 'clear') {
      updateSessionGoal(channel.id, null);
      await replyV2(i, v2Ok('✅ Goal cleared; future prompts will not include the goal reminder.'), { ephemeral: true });
      return;
    }
    if (action === 'complete' || action === 'blocked') {
      if (!session.goal) {
        await replyV2(i, v2Error('❌ There is no goal to update.'), { ephemeral: true });
        return;
      }
      const note = action === 'complete' ? i.options.getString('note') ?? undefined : i.options.getString('reason', true);
      updateSessionGoal(channel.id, { ...session.goal, status: action, note, updatedAt: Date.now() });
      await replyV2(i, v2Ok(action === 'complete' ? '✅ Goal marked complete.' : '⛔ Goal marked blocked.'), { ephemeral: true });
      return;
    }
    if (session.goal?.status === 'active') {
      await replyV2(i, v2Error('⚠ An active goal already exists. Complete, block, or clear it first.'), { ephemeral: true });
      return;
    }
    const objective = i.options.getString('objective', true).trim();
    if (!objective) {
      await replyV2(i, v2Error('❌ Objective cannot be empty.'), { ephemeral: true });
      return;
    }
    updateSessionGoal(channel.id, { objective, status: 'active', updatedAt: Date.now() });
    const { runner, reason } = await bridge.getOrCreate(channel);
    if (!runner) {
      updateSessionGoal(channel.id, null);
      await replyV2(i, v2Error(reason ?? '❌ Runner is unavailable; the goal was not saved.'), { ephemeral: true });
      return;
    }
    await runner.push(`Start pursuing this persistent goal. First assess the current state and proceed with the safest useful next step:\n\n${objective}`, [], i.user.id, { tag: 'goal set' });
    await replyV2(i, v2Ok('🎯 Goal activated. Regular prompts will include it until completion, blockage, or clearing.'), { ephemeral: true });
  },
};
export default command;
