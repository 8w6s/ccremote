import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { requireSessionChannel } from '../../lib/sessionGuard';
import { getSession, updateSessionLoop } from '../../lib/state';
import { bridge } from '../../lib/bridge';
import { replyV2, v2Error, v2Info, v2Ok } from '../../lib/v2';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Manage recurring Claude Code loops.')
    .addSubcommand((sub) => sub
      .setName('start')
      .setDescription('Start a loop.')
      .addStringOption((o) => o.setName('prompt').setDescription('Prompt to repeat').setRequired(true))
      .addStringOption((o) => o.setName('interval').setDescription('For example 5m or 1h; leave empty for self-paced')))
    .addSubcommand((sub) => sub.setName('status').setDescription('Show the loop tracked by the bot.'))
    .addSubcommand((sub) => sub.setName('stop').setDescription('Stop all loops and scheduled wakeups for this session.')) as unknown as SlashCommandBuilder,
  async execute(interaction) {
    const channel = await requireSessionChannel(interaction);
    if (!channel) return;
    const session = getSession(channel.id);
    if (!session) return;
    const action = interaction.options.getSubcommand();
    if (action === 'status') {
      const loop = session.loop;
      await replyV2(interaction, v2Info(loop?.active
        ? `## 🔁 Loop active\n**Interval:** \`${loop.interval ?? 'self-paced'}\`\n**Prompt:** ${loop.prompt}\n-# Locally tracked intent; Claude/Cron confirms the actual schedule in the transcript.`
        : '## 🔁 Loop\nNo active loop is tracked by the bot.'), { ephemeral: true });
      return;
    }
    const { runner, reason } = await bridge.getOrCreate(channel);
    if (!runner) {
      await replyV2(interaction, v2Error(reason ?? '❌ Runner is unavailable.'), { ephemeral: true });
      return;
    }
    if (action === 'start') {
      const prompt = interaction.options.getString('prompt', true);
      const interval = interaction.options.getString('interval') ?? undefined;
      if (session.loop?.active) {
        await replyV2(interaction, v2Error('⚠ A loop is already active. Run `/loop stop` before creating another schedule.'), { ephemeral: true });
        return;
      }
      updateSessionLoop(channel.id, { interval, prompt, active: true, updatedAt: Date.now() });
      await runner.push(`/loop${interval ? ` ${interval}` : ''} ${prompt}`, [], interaction.user.id, { tag: 'loop start' });
      await replyV2(interaction, v2Ok('✅ Loop request sent. Claude will confirm the schedule in the transcript.'), { ephemeral: true });
      return;
    }
    updateSessionLoop(channel.id, { ...(session.loop ?? { prompt: '' }), active: false, updatedAt: Date.now() });
    await runner.push(
      'Stop and cancel every active loop, Cron schedule, and pending ScheduleWakeup created for this session. Confirm what was cancelled.',
      [], interaction.user.id, { tag: 'loop stop' },
    );
    await replyV2(interaction, v2Ok('⏹ Stop request sent; wait for Claude to confirm the cancellation.'), { ephemeral: true });
  },
};

export default command;
