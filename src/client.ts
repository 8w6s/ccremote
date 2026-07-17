import { Client, Collection, GatewayIntentBits, Partials } from 'discord.js';
import { Command, ExtendedClient } from './types';

/**
 * Intent:
 * - Guilds: bắt buộc (bao gồm thread events).
 * - GuildMessages receives messageCreate events in session threads.
 * - GuildMembers (privileged) fetches member data for handoff and roles.
 *
 * Enable privileged intents in Discord Developer Portal → Bot.
 */
export function createClient(): ExtendedClient {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.ThreadMember],
  }) as ExtendedClient;

  client.commands = new Collection<string, Command>();
  return client;
}
