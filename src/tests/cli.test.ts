import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

async function runCli(stateRoot: string, channelId: string): Promise<{ code: number; payload: Record<string, unknown> }> {
  try {
    const result = await execFileAsync(process.execPath, ['-r', 'ts-node/register', 'src/cli.ts', 'resolve-channel', channelId], {
      cwd: process.cwd(),
      env: { ...process.env, XDG_STATE_HOME: stateRoot },
    });
    return { code: 0, payload: JSON.parse(result.stdout) };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    return { code: failure.code ?? 1, payload: JSON.parse(failure.stdout ?? '{}') };
  }
}

test('resolve-channel reports success, missing JSONL, stale, and not found', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clauderemote-cli-test-'));
  const stateDir = join(root, 'clauderemote');
  mkdirSync(stateDir, { recursive: true });
  const jsonl = join(root, 'session.jsonl');
  writeFileSync(jsonl, '{}\n');
  const ids = {
    ok: '123456789012345678',
    missing: '223456789012345678',
    stale: '323456789012345678',
    absent: '423456789012345678',
  };
  writeFileSync(join(stateDir, 'channels.json'), JSON.stringify({
    [ids.ok]: { sessionUuid: 'u1', cwd: '/project', status: 'active', createdAt: 1, lastActiveAt: 1, turnCount: 0, jsonlPath: jsonl, mappingHealth: 'healthy' },
    [ids.missing]: { sessionUuid: 'u2', cwd: '/project', status: 'active', createdAt: 1, lastActiveAt: 1, turnCount: 0, jsonlPath: join(root, 'missing.jsonl'), mappingHealth: 'missing-jsonl' },
    [ids.stale]: { sessionUuid: 'u3', cwd: '/project', status: 'active', createdAt: 1, lastActiveAt: 1, turnCount: 0, jsonlPath: jsonl, mappingHealth: 'stale' },
  }));
  assert.deepEqual(await runCli(root, ids.ok), { code: 0, payload: { channelId: ids.ok, sessionUuid: 'u1', jsonlPath: jsonl, cwd: '/project', sequenceNumber: null, status: 'ok' } });
  assert.equal((await runCli(root, ids.missing)).code, 5);
  assert.equal((await runCli(root, ids.stale)).code, 4);
  assert.equal((await runCli(root, ids.absent)).code, 3);
  assert.equal((await runCli(root, 'invalid')).code, 2);
});

test('resolver fails closed on corrupt state and recovers from a valid backup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clauderemote-cli-corrupt-'));
  const stateDir = join(root, 'clauderemote');
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, 'channels.json');
  const channelId = '523456789012345678';
  writeFileSync(statePath, '{broken');
  assert.equal((await runCli(root, channelId)).code, 6);

  const jsonl = join(root, 'restored.jsonl');
  writeFileSync(jsonl, '{}\n');
  writeFileSync(`${statePath}.bak`, JSON.stringify({
    [channelId]: { sessionUuid: 'backup-uuid', cwd: '/project', status: 'active', createdAt: 1, lastActiveAt: 1, turnCount: 0, jsonlPath: jsonl, mappingHealth: 'healthy' },
  }));
  const restored = await runCli(root, channelId);
  assert.equal(restored.code, 0);
  assert.equal(restored.payload.sessionUuid, 'backup-uuid');
});
