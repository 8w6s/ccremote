import { Client, Guild } from 'discord.js';
import { config } from '../config';
import { log } from './logger';

export function isAuthorizedGuild(guildId: string, authorizedGuildId = config.guildId): boolean {
  return guildId === authorizedGuildId;
}

export async function leaveUnauthorizedGuild(guild: Guild): Promise<boolean> {
  if (isAuthorizedGuild(guild.id)) return false;
  log.warn(`Unauthorized guild detected (${guild.id}); leaving immediately.`);
  await guild.leave();
  log.dim(`Left unauthorized guild ${guild.id}.`);
  return true;
}

export async function reconcileAuthorizedGuild(client: Client): Promise<number> {
  let left = 0;
  for (const guild of client.guilds.cache.values()) {
    try {
      if (await leaveUnauthorizedGuild(guild)) left++;
    } catch (error) {
      log.err(
        `Failed to leave unauthorized guild ${guild.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return left;
}
