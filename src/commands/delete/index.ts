import { SlashCommandBuilder, ChannelType, TextChannel } from 'discord.js';
import { existsSync } from 'node:fs';
import { Command } from '../../types';
import { v2Error, v2Ok, replyV2 } from '../../lib/v2';
import { getSession, deleteSession, setSessionDeleting } from '../../lib/state';
import { bridge } from '../../lib/bridge';
import { cleanupUploads, cleanupTempAttachments } from '../../lib/attachments';
import { jsonlMirror } from '../../lib/jsonlMirror';
import { approvalMcpServer } from '../../lib/approvalMcpServer';
import { log } from '../../lib/logger';
import { claudeSessionJsonlPath } from '../../lib/claudePaths';
import { clearTasks } from '../../lib/taskStore';
import {
  commitTranscriptDeletion,
  rollbackTranscriptDeletion,
  stageTranscriptDeletion,
  StagedTranscriptDeletion,
} from '../../lib/transcriptDeletion';
import { canPermanentlyDelete } from '../../lib/authorization';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('delete')
    .setDescription('Permanently delete this session, Discord channel, and local JSONL.')
    .addBooleanOption((option) => option
      .setName('confirm')
      .setDescription('Confirm permanent deletion')
      .setRequired(true)),
  async execute(interaction) {
    if (!canPermanentlyDelete(interaction.user.id)) {
      await replyV2(interaction, v2Error('❌ Only the owner may permanently delete a session.'), {
        ephemeral: true,
      });
      return;
    }
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

    // 2. Clean up uploads.
    let cleaned = 0;
    try {
      cleaned = cleanupUploads(session.cwd, channel.id);
      cleaned += cleanupTempAttachments(channel.id);
      if (session.sessionUuid) cleaned += cleanupTempAttachments(session.sessionUuid);
    } catch {
      /* ignore */
    }

    let jsonlPath: string | null = null;
    let stagedJsonl: StagedTranscriptDeletion | null = null;
    let jsonlDeleteError: string | null = null;
    if (session.sessionUuid) {
      // Never trust a persisted path for destructive deletion. Recompute the
      // only valid target from the mapped cwd and UUID.
      jsonlPath = claudeSessionJsonlPath(session.cwd, session.sessionUuid);
      try {
        if (existsSync(jsonlPath)) {
          stagedJsonl = stageTranscriptDeletion(jsonlPath);
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
    if (stagedJsonl) parts.push('local JSONL staged for removal');
    if (cleaned > 0) parts.push(`removed ${cleaned} upload files`);
    parts.push('deleting the Discord channel');
    // 6. Remove the mapping only after Discord confirms deletion. Replying is
    // part of the same rollback boundary: a Discord API failure must never
    // leave the transcript stranded in quarantine.
    try {
      await replyV2(interaction, v2Ok(parts.join(' · ') + '.'));
      await channel.delete('clauderemote /delete session');
      if (stagedJsonl) {
        try {
          commitTranscriptDeletion(stagedJsonl);
        } catch (err) {
          // The channel and mapping are gone, but the quarantined transcript
          // remains recoverable instead of risking deletion of another file.
          log.warn(
            `/delete: Discord channel deleted but quarantined JSONL remains at ${stagedJsonl.quarantinePath}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      deleteSession(channel.id);
      clearTasks(channel.id);
    } catch (err) {
      if (stagedJsonl) {
        try {
          rollbackTranscriptDeletion(stagedJsonl);
        } catch (restoreErr) {
          log.err(
            `/delete: CRITICAL — failed to restore quarantined JSONL ${stagedJsonl.quarantinePath}:`,
            restoreErr instanceof Error ? restoreErr.message : restoreErr,
          );
        }
      }
      setSessionDeleting(channel.id, false);
      log.warn('/delete: Discord channel deletion failed:', err instanceof Error ? err.message : err);
    }
  },
};

export default command;
