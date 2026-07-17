import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJsonlEvent } from '../lib/interactionEvents';
import { sortSessionsForBootstrap, formatSequence } from '../lib/sequenceRegistry';
import { buildApprovalDecision, collectQuestionAnswers } from '../lib/approvalRegistry';
import { getTasks, replaceTodos } from '../lib/taskStore';
import { Coalescer } from '../lib/throttle';
import { metadataFromJsonl } from '../lib/sessionSync';
import { readJsonlRecords } from '../lib/jsonlMirror';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeExecutable, shouldScheduleAutomaticRecap } from '../lib/runner';
import { isAuthorizedGuild } from '../lib/guildGuard';
import { isKnownSessionCategory, isLiveSessionCategory } from '../lib/sessionCategories';
import { parseContextUsage } from '../lib/contextUsage';
import { parseModelIds } from '../lib/customApi';
import { Renderer, SessionChannel } from '../lib/renderer';
import { nextArchiveOverflowName } from '../lib/hub';

test('JSONL tool_use and tool_result normalize to matching IDs', () => {
  const use = normalizeJsonlEvent({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } }] },
  });
  const result = normalizeJsonlEvent({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
  });
  assert.equal(use.find((event) => event.type === 'ToolUse')?.toolUseId, 'tool-1');
  assert.equal(result[0]?.type, 'ToolResult');
  if (result[0]?.type === 'ToolResult') assert.equal(result[0].toolUseId, 'tool-1');
});

test('tool result from a second renderer edits the original running card', async () => {
  let sends = 0;
  let edits = 0;
  const message = {
    edit: async () => { edits++; },
  };
  const channel = {
    id: 'tool-correlation-channel',
    send: async () => {
      sends++;
      return message;
    },
  } as unknown as SessionChannel;
  const stdoutRenderer = new Renderer(channel);
  const jsonlRenderer = new Renderer(channel);

  await stdoutRenderer.onToolUse('shared-tool-id', 'Bash', {
    command: 'printf ok',
    description: 'Regression test',
  });
  await jsonlRenderer.onToolResult('shared-tool-id', 'ok', false);

  assert.equal(sends, 1);
  assert.equal(edits, 1);
});

test('retry, rate-limit, and background status components update in place', async () => {
  let sends = 0;
  let edits = 0;
  const channel = {
    id: 'status-lifecycle-channel',
    send: async () => {
      sends++;
      return { edit: async () => { edits++; } };
    },
  } as unknown as SessionChannel;
  const renderer = new Renderer(channel);

  await renderer.postRetry(1, 3, 1000);
  await renderer.postRetry(2, 3, 2000);
  await renderer.postRateLimit('throttled', Date.now() + 10_000, 'tokens');
  await renderer.postRateLimit('allowed', undefined, 'tokens');
  await renderer.postBackgroundTaskStatus('task-1', 'Background task update', 'running');
  await renderer.postBackgroundTaskStatus('task-1', 'Background task completed', 'done', 'completed');

  assert.equal(sends, 3);
  assert.equal(edits, 3);
});

test('transient assistant edit failure does not create a replacement message', async () => {
  let sends = 0;
  let editAttempts = 0;
  const message = {
    edit: async () => {
      editAttempts++;
      if (editAttempts === 1) throw new Error('transient network failure');
    },
  };
  const channel = {
    id: 'assistant-identity-channel',
    send: async () => {
      sends++;
      return message;
    },
  } as unknown as SessionChannel;
  const renderer = new Renderer(channel);

  renderer.startTurn();
  await renderer.appendAssistantText('one');
  await renderer.endAssistantText();
  await renderer.appendAssistantText(' two');
  await renderer.endAssistantText();
  await renderer.appendAssistantText(' three');
  await renderer.endAssistantText();

  assert.equal(sends, 1);
  assert.equal(editAttempts, 2);
});

test('thinking and internal JSONL events are not rendered', () => {
  assert.deepEqual(normalizeJsonlEvent({ type: 'system', subtype: 'init' }), []);
  assert.deepEqual(normalizeJsonlEvent({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'secret' }] } }), [{ type: 'AssistantTextEnd' }]);
});

test('bootstrap ordering uses timestamp then UUID/path deterministically', () => {
  const sorted = sortSessionsForBootstrap([
    { uuid: 'b', createdAtMs: 20, path: '/b' },
    { uuid: 'c', createdAtMs: 10, path: '/c' },
    { uuid: 'a', createdAtMs: 20, path: '/a' },
  ]);
  assert.deepEqual(sorted.map((item) => item.uuid), ['c', 'a', 'b']);
  assert.equal(formatSequence(1), 's-0000-0001');
  assert.equal(formatSequence(10000), 's-0001-0000');
});

test('JSONL creation timestamp is independent from the event containing cwd', () => {
  const root = mkdtempSync(join(tmpdir(), 'clauderemote-meta-'));
  const path = join(root, 'session.jsonl');
  writeFileSync(path, [
    JSON.stringify({ type: 'system', timestamp: '2026-01-02T03:04:05.000Z' }),
    JSON.stringify({ type: 'user', cwd: '/project', timestamp: '2026-02-03T04:05:06.000Z' }),
  ].join('\n'));
  assert.deepEqual(metadataFromJsonl(path), {
    cwd: '/project',
    timestamp: Date.parse('2026-01-02T03:04:05.000Z'),
  });
});

test('AskUserQuestion submission permits unanswered questions', () => {
  const answers = collectQuestionAnswers({
    current: 0,
    questions: [
      { question: 'Single?', options: [{ label: 'A', description: 'first' }] },
      { question: 'Multi?', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] },
      { question: 'Skipped?', options: [{ label: 'No answer' }] },
    ],
    answers: [['A'], ['X', 'Y'], []],
  });
  assert.deepEqual(answers, { 'Single?': 'A', 'Multi?': 'X, Y' });
});

test('Approve once never persists permission suggestions; Always does', () => {
  const args = {
    tool_name: 'Bash',
    input: { command: 'pwd' },
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }] }],
  };
  assert.equal(buildApprovalDecision(args, 'yes').updatedPermissions, undefined);
  assert.deepEqual(buildApprovalDecision(args, 'always').updatedPermissions, args.permission_suggestions);
});

test('JSONL reader reports exact LF, CRLF, and final-record byte boundaries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clauderemote-records-'));
  const path = join(root, 'session.jsonl');
  const content = '{"a":1}\r\n{"b":"é"}\n{"c":3}';
  writeFileSync(path, content);
  const records = [];
  for await (const record of readJsonlRecords(path, 0, Buffer.byteLength(content))) records.push(record);
  assert.deepEqual(records.map((record) => record.line), ['{"a":1}', '{"b":"é"}', '{"c":3}']);
  const first = Buffer.byteLength('{"a":1}\r\n');
  const second = first + Buffer.byteLength('{"b":"é"}\n');
  assert.deepEqual(records.map((record) => record.endOffset), [first, second, Buffer.byteLength(content)]);
});

test('task caches stay isolated by channel', () => {
  replaceTodos('channel-a', [{ content: 'A', status: 'pending' }]);
  replaceTodos('channel-b', [{ content: 'B', status: 'completed' }]);
  assert.equal(getTasks('channel-a')[0]?.content, 'A');
  assert.equal(getTasks('channel-b')[0]?.content, 'B');
});

test('streaming coalescer never runs two edits concurrently', async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const coalescer = new Coalescer(0, async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
  });
  coalescer.schedule();
  coalescer.schedule();
  await coalescer.flush();
  assert.equal(maxActive, 1);
  assert.ok(calls >= 1);
});

test('automatic recap requires opt-in and at least three turns', () => {
  const base = {
    sessionUuid: null,
    cwd: '/project',
    status: 'active' as const,
    createdAt: 1,
    lastActiveAt: 1,
    turnCount: 3,
  };
  assert.equal(shouldScheduleAutomaticRecap({ ...base, recap: { enabled: true } }, false), true);
  assert.equal(shouldScheduleAutomaticRecap({ ...base, turnCount: 2, recap: { enabled: true } }, false), false);
  assert.equal(shouldScheduleAutomaticRecap({ ...base, recap: { enabled: false } }, false), false);
  assert.equal(shouldScheduleAutomaticRecap({ ...base, recap: { enabled: true } }, true), false);
});

test('single-guild guard authorizes only the configured guild ID', () => {
  assert.equal(isAuthorizedGuild('guild-primary', 'guild-primary'), true);
  assert.equal(isAuthorizedGuild('guild-secondary', 'guild-primary'), false);
  assert.equal(isAuthorizedGuild('', 'guild-primary'), false);
});

test('background category is live while unrelated categories stay rejected', () => {
  const categories = { active: 'active', background: 'background', archive: 'archive' };
  assert.equal(isLiveSessionCategory('active', categories), true);
  assert.equal(isLiveSessionCategory('background', categories), true);
  assert.equal(isLiveSessionCategory('archive', categories), false);
  assert.equal(isKnownSessionCategory('archive', categories), true);
  assert.equal(isKnownSessionCategory('unrelated', categories), false);
  assert.equal(isKnownSessionCategory(null, categories), false);
});

test('archive overflow names remain deterministic beyond Discord category capacity', () => {
  assert.equal(nextArchiveOverflowName('close session', []), 'close session-overflow 0001');
  assert.equal(
    nextArchiveOverflowName('close session', [
      'close session-overflow 0001',
      'close session-overflow 0002',
    ]),
    'close session-overflow 0003',
  );
  assert.equal(
    nextArchiveOverflowName('close session', ['close session-overflow']),
    'close session-overflow 0002',
  );
});

test('Claude executable prefers the absolute daemon configuration', () => {
  assert.equal(claudeExecutable({ CLAUDE_BIN: '/opt/claude/bin/claude' }), '/opt/claude/bin/claude');
  assert.equal(claudeExecutable({ CLAUDE_BIN: '  ' }), 'claude');
});

test('context usage parser preserves distinct skill, context, and free-space symbols', () => {
  const usage = parseContextUsage([
    'Opus 4.7 (1M context)',
    '129.8k/1m tokens (13%)',
    'Skills: 2.3k tokens (0.2%)',
    'Messages: 127.4k tokens (12.7%)',
    'Free space: 870.2k (87.0%)',
  ].join('\n'));
  assert.ok(usage);
  assert.equal(usage.skillsTokens, 2300);
  assert.equal(usage.contextTokens, 127500);
  assert.equal(usage.freeTokens, 870200);
  assert.equal(usage.grid.length, 50);
  assert.match(usage.grid, /^[⛀⛁]+[⛂⛃]+⛶+$/u);
});

test('custom API model aliases require exactly opus, sonnet, and haiku', () => {
  assert.deepEqual(parseModelIds('opus=o,sonnet=s,haiku=h'), {
    opus: 'o', sonnet: 's', haiku: 'h',
  });
  assert.deepEqual(parseModelIds('o,s,h'), { opus: 'o', sonnet: 's', haiku: 'h' });
  assert.equal(parseModelIds('opus=o,sonnet=s'), null);
  assert.equal(parseModelIds('o,s'), null);
});
