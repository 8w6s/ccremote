#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { getSession } from './lib/state';

function output(payload: Record<string, unknown>, exitCode: number): never {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(exitCode);
}

function resolveChannel(channelId: string | undefined): never {
  if (!channelId || !/^\d{15,22}$/.test(channelId)) {
    return output({ channelId: channelId ?? null, status: 'invalid-channel-id' }, 2);
  }
  let session;
  try {
    session = getSession(channelId);
  } catch (error) {
    return output({ channelId, status: 'database-unavailable', error: String(error) }, 6);
  }
  if (!session) return output({ channelId, status: 'not-found' }, 3);
  const base = {
    channelId,
    sessionUuid: session.sessionUuid,
    jsonlPath: session.jsonlPath ?? null,
    cwd: session.cwd,
    sequenceNumber: session.sequenceNumber ?? null,
  };
  if (session.channelDeleted || session.mappingHealth === 'stale') {
    return output({ ...base, status: 'stale-mapping' }, 4);
  }
  if (!session.jsonlPath || !existsSync(session.jsonlPath)) {
    return output({ ...base, status: 'jsonl-missing' }, 5);
  }
  return output({ ...base, status: 'ok' }, 0);
}

const [, , command, argument] = process.argv;
if (command === 'resolve-channel') resolveChannel(argument);
output({ status: 'usage', usage: 'clauderemote resolve-channel <discord_channel_id>' }, 2);
