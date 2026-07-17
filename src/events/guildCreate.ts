import { BotEvent } from '../types';
import { leaveUnauthorizedGuild } from '../lib/guildGuard';

const event: BotEvent<'guildCreate'> = {
  name: 'guildCreate',
  async execute(guild) {
    await leaveUnauthorizedGuild(guild);
  },
};

export default event;
