import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalMcpServer, isLoopbackAddress } from '../lib/approvalMcpServer';
import { claudeExecutable, claudeSessionJsonlPath, encodeClaudeCwd } from '../lib/claudePaths';
import { resetSessionForCwdChange, SessionState } from '../lib/state';
import { registerSecret, scrub } from '../lib/scrubber';
import { Bridge } from '../lib/bridge';
import { readUserPromptsFromPath } from '../lib/rewind';
import { canPermanentlyDelete, isAuthorizedUser } from '../lib/authorization';
import { OverwriteType, PermissionsBitField } from 'discord.js';
import {
  commitTranscriptDeletion,
  rollbackTranscriptDeletion,
  stageTranscriptDeletion,
} from '../lib/transcriptDeletion';
import { clearTasks, getTasks, hydrateTasksFromJsonl } from '../lib/taskStore';
import { sanitizeLogValue } from '../lib/logger';

test('cwd rotation clears every transcript and mirror identity field', () => {
  const session = {
    cwd: '/old',
    sessionUuid: 'old-uuid',
    jsonlPath: '/old/session.jsonl',
    mirrorOffset: 1234,
    syncCheckpoint: 1234,
    syncTotal: 5678,
    syncState: 'running',
    syncing: true,
    mappingHealth: 'stale',
    status: 'active',
    createdAt: 1,
    lastActiveAt: 1,
    turnCount: 1,
  } satisfies SessionState;

  resetSessionForCwdChange(session, '/new');

  assert.equal(session.cwd, '/new');
  assert.equal(session.sessionUuid, null);
  assert.equal(session.jsonlPath, null);
  assert.equal(session.mirrorOffset, 0);
  assert.equal(session.syncCheckpoint, 0);
  assert.equal(session.syncTotal, 0);
  assert.equal(session.syncState, 'idle');
  assert.equal(session.syncing, false);
  assert.equal(session.mappingHealth, 'healthy');
});

test('Claude project encoding and JSONL path share one canonical policy', () => {
  assert.equal(encodeClaudeCwd('/home/example/project'), '-home-example-project');
  assert.equal(encodeClaudeCwd('C:\\Users\\example\\project'), 'C--Users-example-project');
  assert.match(
    claudeSessionJsonlPath('/home/example/project', 'session-id'),
    /\.claude[\\/]projects[\\/]-home-example-project[\\/]session-id\.jsonl$/,
  );
});

test('Claude executable policy is shared by daemon-managed auth and runners', () => {
  assert.equal(claudeExecutable({ CLAUDE_BIN: '/opt/claude/bin/claude' }), '/opt/claude/bin/claude');
  assert.equal(claudeExecutable({}), 'claude');
});

test('reconfiguration waits for an active turn before mutating state', async () => {
  const bridge = new Bridge();
  let afterTurn: (() => void) | null = null;
  let applied = false;
  let stopped = false;
  const fakeRunner = {
    isTurnActive: () => true,
    afterCurrentTurn: (callback: () => void) => { afterTurn = callback; },
    stop: async () => { stopped = true; },
  };
  const internals = bridge as unknown as { runners: Map<string, typeof fakeRunner> };
  internals.runners.set('channel', fakeRunner);

  const timing = await bridge.reconfigureAfterTurn('channel', () => { applied = true; });
  assert.equal(timing, 'deferred');
  assert.equal(applied, false);
  assert.ok(afterTurn);
  (afterTurn as () => void)();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(applied, true);
  assert.equal(stopped, true);
});

test('bridge counts and stops runners that are still starting', async () => {
  const bridge = new Bridge();
  let stopped = false;
  const fakeRunner = {
    abort: () => {},
    stop: async () => { stopped = true; },
  };
  const internals = bridge as unknown as {
    runners: Map<string, typeof fakeRunner>;
    starting: Map<string, Promise<{ runner: typeof fakeRunner }>>;
  };
  const starting = Promise.resolve().then(() => {
    internals.runners.set('starting-channel', fakeRunner);
    return { runner: fakeRunner };
  });
  internals.starting.set('starting-channel', starting);

  assert.equal(bridge.size(), 1);
  await bridge.stopAll();
  assert.equal(stopped, true);
});

test('approval MCP accepts only exact loopback address forms', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('attacker-127.0.0.1'), false);
  assert.equal(isLoopbackAddress('127.0.0.10'), false);
});

test('approval MCP config uses a per-channel unguessable endpoint token', async () => {
  await approvalMcpServer.start(async () => ({ behavior: 'deny' }));
  try {
    const channelId = '987654321012345678';
    const configPath = await approvalMcpServer.registerChannel(channelId);
    assert.ok(configPath);
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      mcpServers: { cr: { url: string } };
    };
    assert.match(
      config.mcpServers.cr.url,
      new RegExp(`/mcp/${channelId}/[0-9a-f-]{36}$`, 'i'),
    );
    const legacyUrl = `http://127.0.0.1:${approvalMcpServer.getPort()}/mcp/${channelId}`;
    const response = await fetch(legacyUrl);
    assert.equal(response.status, 404);
  } finally {
    await approvalMcpServer.stop();
  }
});

test('newly registered literal secrets are scrubbed after cache invalidation', () => {
  const first = 'hardening-secret-alpha-123456';
  const second = 'hardening-secret-beta-654321';
  registerSecret(first);
  assert.equal(scrub(`value=${first}`), 'value=[REDACTED:env-secret]');
  registerSecret(second);
  assert.equal(scrub(`${first} ${second}`), '[REDACTED:env-secret] [REDACTED:env-secret]');
});

test('rewind streams JSONL and excludes tool-result user records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccremote-rewind-'));
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, [
    JSON.stringify({ type: 'user', uuid: 'one', message: { content: 'first prompt' } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'result' }] } }),
    JSON.stringify({ type: 'user', uuid: 'two', message: { content: [{ type: 'text', text: 'second prompt' }] } }),
  ].join('\n'));
  try {
    const prompts = await readUserPromptsFromPath(path);
    assert.deepEqual(prompts.map((prompt) => prompt.text), ['first prompt', 'second prompt']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit member handoff permissions authorize only that Discord user', () => {
  const allowed = new PermissionsBitField([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
  ]);
  const channel = {
    permissionOverwrites: {
      cache: new Map([
        ['handoff-user', { type: OverwriteType.Member, allow: allowed }],
      ]),
    },
  };
  assert.equal(isAuthorizedUser('handoff-user', channel), true);
  assert.equal(isAuthorizedUser('different-user', channel), false);
  assert.equal(canPermanentlyDelete('handoff-user'), false);
});

test('staged transcript deletion rolls back or commits without losing the original early', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clauderemote-delete-'));
  const transcript = join(dir, 'session.jsonl');
  try {
    writeFileSync(transcript, 'important transcript');
    const rollback = stageTranscriptDeletion(transcript);
    assert.ok(rollback);
    assert.equal(existsSync(transcript), false);
    rollbackTranscriptDeletion(rollback);
    assert.equal(readFileSync(transcript, 'utf8'), 'important transcript');

    const commit = stageTranscriptDeletion(transcript);
    assert.ok(commit);
    commitTranscriptDeletion(commit);
    assert.equal(existsSync(transcript), false);
    assert.equal(existsSync(commit.quarantinePath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clearing a task cache cancels an in-flight JSONL hydration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clauderemote-task-hydrate-'));
  const transcript = join(dir, 'session.jsonl');
  const channelId = 'deleted-channel';
  const event = JSON.stringify({
    message: {
      content: [{ type: 'tool_use', id: 'task-1', name: 'TaskCreate', input: { subject: 'stale' } }],
    },
  });
  try {
    writeFileSync(transcript, `${event}\n`.repeat(2_000));
    const hydration = hydrateTasksFromJsonl(channelId, transcript);
    clearTasks(channelId);
    await hydration;
    assert.deepEqual(getTasks(channelId), []);
  } finally {
    clearTasks(channelId);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logger output scrubs secrets in strings, errors, and structured values', () => {
  const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz123456';
  assert.doesNotMatch(sanitizeLogValue(`failed with ${secret}`), /sk-ant-/);
  assert.doesNotMatch(sanitizeLogValue(new Error(`failed with ${secret}`)), /sk-ant-/);
  assert.doesNotMatch(sanitizeLogValue({ authorization: `Bearer ${secret}` }), /sk-ant-/);
  const callback = 'https://discord.com/api/v10/interactions/1234567890/aVeryLongInteractionToken_123456789/callback';
  const sanitized = sanitizeLogValue(new Error(callback));
  assert.doesNotMatch(sanitized, /aVeryLongInteractionToken/);
  assert.match(sanitized, /REDACTED:interaction-token/);
});
