import chalk from 'chalk';
import { ChannelType, TextChannel } from 'discord.js';
import { BotEvent } from '../types';
import { ensureHub, reconcileClosedSessionArchives } from '../lib/hub';
import { config } from '../config';
import {
  listActiveSessions,
  listPendingPrompts,
  clearPromptPending,
} from '../lib/state';
import { log } from '../lib/logger';
import { v2Error, V2_FLAGS } from '../lib/v2';
import { jsonlMirror } from '../lib/jsonlMirror';
import { approvalMcpServer } from '../lib/approvalMcpServer';
import { requestApproval, setDiscordClient } from '../lib/approvalRegistry';
import { bootstrapSessionIdentity, reconcileSessionMappings, resumeIncompleteSyncs } from '../lib/sessionSync';

const event: BotEvent<'clientReady'> = {
  name: 'clientReady',
  once: true,
  async execute(client) {
    console.log(chalk.green(`✓ Bot logged in: ${client.user?.tag}`));
    console.log(chalk.gray(`  Guild: ${config.guildId}, Owner: ${config.ownerId}`));

    setDiscordClient(client);
    await approvalMcpServer.start(requestApproval);

    const identity = bootstrapSessionIdentity();
    log.dim(`Session identity bootstrap: ${identity.discovered} transcripts, ${identity.migrated} migrated fields.`);

    await ensureHub(client);
    await reconcileClosedSessionArchives(client);
    const mappings = await reconcileSessionMappings(client);
    log.dim(`Mapping reconciliation: ${mappings.healthy} healthy, ${mappings.stale} stale, ${mappings.duplicates} duplicate rows.`);

    const active = listActiveSessions();
    log.dim(`${active.length} active session(s) in state (resumed lazily on the next message).`);

    const pending = listPendingPrompts(5 * 60_000);
    for (const p of pending) {
      try {
        const ch = await client.channels.fetch(p.channelId).catch(() => null);
        if (!ch || ch.type !== ChannelType.GuildText) {
          clearPromptPending(p.channelId);
          continue;
        }
        const text = ch as TextChannel;
        const ageSec = Math.round((Date.now() - p.pendingAt) / 1000);
        await text.send({
          components: [
            v2Error(
              `⚠ A recent prompt (${ageSec}s ago) may have been **interrupted by a bot restart**. ` +
                `Claude Code did not return a final \`result\`. Check the output above and resend ` +
                `the prompt if it is incomplete; the session was resumed safely.`,
            ),
          ],
          flags: V2_FLAGS,
          allowedMentions: { parse: [] },
        });
        clearPromptPending(p.channelId);
      } catch (err) {
        log.warn(
          `Could not post pending warning for ${p.channelId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (pending.length > 0) {
      log.dim(`Warned ${pending.length} session(s) about an interrupted in-flight prompt.`);
    }

    jsonlMirror.start(client);
    const resumedSyncs = await resumeIncompleteSyncs(client);
    if (resumedSyncs > 0) log.dim(`Resumed ${resumedSyncs} checkpointed transcript sync(s).`);

  },
};

export default event;
