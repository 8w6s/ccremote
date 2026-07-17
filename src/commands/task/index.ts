import { SlashCommandBuilder } from 'discord.js';
import { Command } from '../../types';
import { requireSessionChannel } from '../../lib/sessionGuard';
import { getTasks, hydrateTasksFromJsonl } from '../../lib/taskStore';
import { replyV2, v2Panel } from '../../lib/v2';
import { getSession } from '../../lib/state';
import { existsSync } from 'node:fs';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('task')
    .setDescription('Show the current Claude Code task list.'),
  async execute(interaction) {
    const channel = await requireSessionChannel(interaction);
    if (!channel) return;
    const session = getSession(channel.id);
    let tasks = getTasks(channel.id);
    if (tasks.length === 0 && session?.jsonlPath && existsSync(session.jsonlPath)) {
      await hydrateTasksFromJsonl(channel.id, session.jsonlPath);
      tasks = getTasks(channel.id);
    }
    const body = tasks.length === 0
      ? '_Claude has not created any tasks in the current runtime._'
      : tasks.map((task) => {
          const icon = task.status === 'completed' ? '☑' : task.status === 'in_progress' ? '⏳' : '☐';
          const detail = task.description ? `\n  -# ${task.description.slice(0, 220)}` : '';
          return `${icon} **${task.content}**${detail}`;
        }).join('\n');
    await replyV2(interaction, v2Panel({ title: '📋 Claude tasks', body }), { ephemeral: true });
  },
};

export default command;
