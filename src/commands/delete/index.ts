import { SlashCommandBuilder, ChannelType, TextChannel } from 'discord.js';
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Command } from '../../types';
import { v2Error, v2Ok, replyV2 } from '../../lib/v2';
import { getSession, deleteSession, setSessionDeleting } from '../../lib/state';
import { bridge } from '../../lib/bridge';
import { cleanupUploads, cleanupTempAttachments } from '../../lib/attachments';
import { jsonlMirror } from '../../lib/jsonlMirror';
import { approvalMcpServer } from '../../lib/approvalMcpServer';
import { log } from '../../lib/logger';

/**
 */
function encodeCwd(cwd: string): string {
  return '-' + cwd.replace(/\//g, '-').replace(/^-+/, '');
}

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('delete')
    .setDescription('Permanently delete this session, Discord channel, and local JSONL.')
    .addBooleanOption((option) => option
      .setName('confirm')
      .setDescription('Confirm permanent deletion')
      .setRequired(true)),
  async execute(interaction) {
    if (!interaction.options.getBoolean('confirm', true)) {
      await replyV2(interaction, v2Error('Deletion cancelled.'), { ephemeral: true });
      return;
    }
    const ch = interaction.channel;
    if (!ch || ch.type !== ChannelType.GuildText) {
      await replyV2(interaction, v2Error('❌ /delete only works in a session channel.'), {
        ephemeral: true,
      });
      return;
    }
    const channel = ch as TextChannel;
    const session = getSession(channel.id);
    if (!session) {
      await replyV2(interaction, v2Error('❌ This channel is not a Claude session.'), {
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();
    // 1. Stop the Runner, JSONL watcher, and channel-specific MCP registration.
    await bridge.drop(channel.id);
    jsonlMirror.removeWatcher(channel.id);
    await approvalMcpServer.unregisterChannel(channel.id).catch(() => {});

    // 2. Dọn uploads.
    let cleaned = 0;
    try {
      cleaned = cleanupUploads(session.cwd, channel.id);
      cleaned += cleanupTempAttachments(channel.id);
      if (session.sessionUuid) cleaned += cleanupTempAttachments(session.sessionUuid);
    } catch {
      /* ignore */
    }

    let jsonlDeleted = false;
    let jsonlDeleteError: string | null = null;
    if (session.sessionUuid) {
      const jsonlPath = session.jsonlPath ?? join(
        homedir(),
        '.claude',
        'projects',
        encodeCwd(session.cwd),
        `${session.sessionUuid}.jsonl`,
      );
      try {
        if (existsSync(jsonlPath)) {
          unlinkSync(jsonlPath);
          jsonlDeleted = true;
        }
      } catch (err) {
        jsonlDeleteError = err instanceof Error ? err.message : String(err);
        log.warn(
          `/delete: failed to delete JSONL ${jsonlPath}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Preserve the mapping and channel when the authoritative transcript could
    // not be deleted. The user can fix permissions and retry safely.
    if (jsonlDeleteError) {
      await replyV2(
        interaction,
        v2Error(`❌ Local JSONL could not be deleted. Mapping and Discord channel were preserved for retry.\n-# ${jsonlDeleteError.slice(0, 500)}`),
        { ephemeral: true },
      );
      return;
    }

    // 4. Mark the operation before asking Discord to delete the channel. The
    // channelDelete recovery handler sees this marker and does not respawn it.
    setSessionDeleting(channel.id, true);

    // 5. Reply before deleting the channel so Discord can acknowledge the command.
    const parts: string[] = ['🗑 Session permanently deleted'];
    if (jsonlDeleted) parts.push('local JSONL removed');
    if (cleaned > 0) parts.push(`removed ${cleaned} upload files`);
    parts.push('deleting the Discord channel');
    await replyV2(interaction, v2Ok(parts.join(' · ') + '.'));

    // 6. Remove the mapping only after Discord confirms deletion. On failure,
    // clear the marker and retain the mapping so the operation can be retried.
    try {
      await channel.delete('clauderemote /delete session');
      deleteSession(channel.id);
    } catch (err) {
      setSessionDeleting(channel.id, false);
      log.warn('/delete: Discord channel deletion failed:', err instanceof Error ? err.message : err);
    }
  },
};

export default command;
