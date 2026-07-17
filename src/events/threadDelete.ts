import { BotEvent } from '../types';
import { getSession, deleteSession } from '../lib/state';
import { clearNotify } from '../lib/notify';
import { bridge } from '../lib/bridge';
import { log } from '../lib/logger';
import { clearTasks } from '../lib/taskStore';

/**
 */
const event: BotEvent<'threadDelete'> = {
  name: 'threadDelete',
  async execute(thread) {
    const row = getSession(thread.id);
    if (!row) return;

    log.dim(`threadDelete: clean up session ${thread.id} (${thread.name ?? '?'})`);
    await bridge.drop(thread.id).catch(() => {});
    deleteSession(thread.id);
    clearTasks(thread.id);
    clearNotify(thread.id);
  },
};

export default event;
