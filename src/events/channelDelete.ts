import { ChannelType, TextChannel, CategoryChannel } from 'discord.js';
import { existsSync } from 'node:fs';
import { BotEvent } from '../types';
import { config } from '../config';
import {
  getSession,
  markChannelDeleted,
  migrateSessionChannel,
} from '../lib/state';
import { clearNotify } from '../lib/notify';
import { bridge } from '../lib/bridge';
import { log } from '../lib/logger';
import { buildSessionHeader } from '../lib/renderer';
import { V2_FLAGS } from '../lib/v2';
import { claudeSessionJsonlPath } from '../lib/claudePaths';

/**
 *
 */
const event: BotEvent<'channelDelete'> = {
  name: 'channelDelete',
  async execute(channel) {
    const id = 'id' in channel ? channel.id : null;
    if (!id) return;
    const row = getSession(id);
    if (!row) return; // /delete already removed the mapping; do not respawn.

    // `/delete` keeps the mapping until Discord confirms channel deletion.
    // This durable marker prevents the normal recovery path from respawning it.
    if (row.deleting) return;

    await bridge.drop(id).catch(() => {});
    clearNotify(id);

    if (row.status === 'closed' || !row.sessionUuid) {
      log.dim(
        `channelDelete: soft-delete session ${id} (closed or missing UUID)`,
      );
      markChannelDeleted(id);
      return;
    }

    const jsonlPath = claudeSessionJsonlPath(row.cwd, row.sessionUuid);
    if (!existsSync(jsonlPath)) {
      log.dim(
        `channelDelete: JSONL ${jsonlPath} is missing; soft-delete ${id}`,
      );
      markChannelDeleted(id);
      return;
    }

    const oldName =
      'name' in channel && typeof channel.name === 'string' ? channel.name : `s-${id.slice(-6)}`;
    const cleanName = oldName.replace(/^🔒[\-\s]*/, '').slice(0, 90);

    const client = 'client' in channel ? channel.client : null;
    if (!client) {
      log.warn(`channelDelete: Discord client unavailable; cannot respawn ${id}`);
      markChannelDeleted(id);
      return;
    }

    const cat = await client.channels.fetch(config.categoryId).catch(() => null);
    if (!cat || cat.type !== ChannelType.GuildCategory) {
      log.warn(`channelDelete: CATEGORY_ID is invalid; cannot respawn ${id}`);
      markChannelDeleted(id);
      return;
    }
    const category = cat as CategoryChannel;

    let newChannel: TextChannel | null = null;
    try {
      newChannel = await category.guild.channels.create({
        name: cleanName,
        type: ChannelType.GuildText,
        parent: category.id,
        reason: `clauderemote auto-respawn (deleted channel ${id})`,
      });
    } catch (err) {
      log.err(
        'channelDelete: failed to create recovery channel:',
        err instanceof Error ? err.message : err,
      );
      markChannelDeleted(id);
      return;
    }

    // Migrate row DB.
    const migrated = migrateSessionChannel(id, newChannel.id);
    if (!migrated) {
      log.err(`channelDelete: failed to migrate mapping for ${id}`);
      await newChannel.delete('respawn rollback').catch(() => {});
      return;
    }

    // Post header + note recovery.
    const header = buildSessionHeader({
      cwd: migrated.cwd,
      permissionMode: migrated.permissionMode ?? 'bypassPermissions',
      model: migrated.model ?? undefined,
      sessionId: migrated.sessionUuid ?? undefined,
    });
    await newChannel
      .send({
        components: [header],
        flags: V2_FLAGS,
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
    await newChannel
      .send({
        content: `-# ♻️ The previous channel (\`${id}\`) was deleted, but its JSONL survived. The session was restored here; send a message to continue.`,
        allowedMentions: { parse: [] },
      })
      .catch(() => {});

    log.dim(
      `channelDelete: respawn ${id} → ${newChannel.id} (uuid=${migrated.sessionUuid})`,
    );
  },
};

export default event;
