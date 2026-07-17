import { SlashCommandBuilder, ChannelType } from 'discord.js';
import { Command } from '../../types';
import { v2Panel, replyV2 } from '../../lib/v2';
import { getSession, listActiveSessions } from '../../lib/state';
import { bridge } from '../../lib/bridge';
import { config } from '../../config';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatSequence } from '../../lib/sequenceRegistry';
import { isLiveSessionCategory } from '../../lib/sessionCategories';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show this session status or the global overview.'),
  async execute(interaction) {
    const ch = interaction.channel;
    const isSessionChannel =
      ch?.type === ChannelType.GuildText &&
      isLiveSessionCategory(ch.parentId, {
        active: config.categoryId,
        background: config.backgroundCategoryId,
      });
    if (isSessionChannel && ch) {
      const session = getSession(ch.id);
      if (session) {
        const runner = bridge.getRunnerForChannel(ch.id);
        const runnerAlive = Boolean(runner);
        const jsonlExists = Boolean(session.jsonlPath && existsSync(session.jsonlPath));
        const syncCheckpoint = session.syncCheckpoint ?? 0;
        const syncTotal = session.syncTotal ?? 0;
        const syncPercent = syncTotal > 0 ? Math.min(100, Math.floor((syncCheckpoint / syncTotal) * 100)) : 0;
        const container = v2Panel({
          title: `🟣 Session ${ch.name}`,
          fields: [
            { label: 'Claude session UUID', value: session.sessionUuid ?? '_(not initialized)_' },
            { label: 'Sequence', value: session.sequenceNumber ? formatSequence(session.sequenceNumber) : 'unassigned' },
            { label: 'Discord channel ID', value: ch.id },
            { label: 'CWD', value: `\`${session.cwd}\`` },
            { label: 'Source', value: session.source ?? 'unknown' },
            { label: 'Session type', value: session.sessionType ?? 'foreground' },
            ...(session.sessionType === 'background'
              ? [{ label: 'Background state', value: session.backgroundStatus ?? 'idle' }]
              : []),
            { label: 'Created', value: `<t:${Math.floor(session.createdAt / 1000)}:F>` },
            { label: 'Status', value: session.status },
            { label: 'Turns', value: String(session.turnCount) },
            { label: 'Effort', value: session.effort ?? 'auto (model default)' },
            {
              label: 'Goal',
              value: session.goal
                ? `${session.goal.status} · ${session.goal.objective.slice(0, 100)}`
                : 'none',
            },
            {
              label: 'Runner',
              value: runnerAlive ? '✅ running' : '⚪ idle',
            },
            { label: 'Attached', value: runnerAlive ? 'live' : 'offline' },
            { label: 'Current tool', value: runner?.getCurrentTool() ?? 'none' },
            { label: 'Permission mode', value: session.permissionMode ?? 'bypassPermissions' },
            {
              label: 'Automatic recap',
              value: session.recap?.enabled
                ? `enabled${session.recap.lastGeneratedAt ? ` · last <t:${Math.floor(session.recap.lastGeneratedAt / 1000)}:R>` : ''}`
                : 'disabled',
            },
            { label: 'Sync', value: `${session.syncState ?? 'idle'} · ${syncPercent}% · ${syncCheckpoint}/${syncTotal} bytes` },
            { label: 'JSONL', value: session.jsonlPath ? `\`${session.jsonlPath}\` · ${jsonlExists ? 'exists' : 'missing'}` : 'unmapped' },
            { label: 'Mapping health', value: session.mappingHealth ?? 'unknown' },
            { label: 'Attachment temp', value: `\`${join(tmpdir(), 'clauderemote', session.sessionUuid ?? ch.id)}\`` },
            {
              label: 'Last active',
              value: `<t:${Math.floor(session.lastActiveAt / 1000)}:R>`,
            },
          ],
        });
        await replyV2(interaction, container, { ephemeral: true });
        return;
      }
    }

    const list = listActiveSessions();
    const container = v2Panel({
      title: '🟣 clauderemote overview',
      body:
        `**Active sessions:** ${list.length}\n` +
        `**Running runners:** ${bridge.size()}\n\n` +
        (list.length === 0
          ? '_No sessions yet._'
          : list
              .slice(0, 15)
              .map(
                (s) =>
                  `• <#${s.channelId}> · \`${s.cwd}\` · ${s.turnCount} turns · <t:${Math.floor(s.lastActiveAt / 1000)}:R>`,
              )
              .join('\n')),
    });
    await replyV2(interaction, container, { ephemeral: true });
  },
};

export default command;
