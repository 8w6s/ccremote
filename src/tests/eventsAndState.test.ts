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
