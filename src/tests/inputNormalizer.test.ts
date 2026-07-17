import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDiscordRequest, stripCustomDiscordEmoji } from '../lib/inputNormalizer';
import { buildTempAttachmentPath, decodeTextAttachment, sanitizeFilename } from '../lib/attachments';

const base = { sourceMessageId: '123', channelId: '456', sessionUuid: 'uuid' };

test('strips static and animated custom emoji but preserves Unicode emoji', () => {
  assert.equal(stripCustomDiscordEmoji('fix this <:pepe:123456789> <a:dance:987654321> 😂'), 'fix this   😂');
});

test('custom-emoji-only and sticker-only input is ignored', () => {
  assert.equal(normalizeDiscordRequest({ ...base, content: '<:pepe:123456789>', stickerCount: 0 }), null);
  assert.equal(normalizeDiscordRequest({ ...base, content: '   ', stickerCount: 1 }), null);
});

test('Unicode emoji remains a valid prompt', () => {
  assert.equal(normalizeDiscordRequest({ ...base, content: '😂' })?.text, '😂');
});

test('visible message text and Discord messages.txt content are both preserved', () => {
  const request = normalizeDiscordRequest({
    ...base,
    content: 'abcxyz',
    inlineAttachments: [{ name: 'messages.txt', text: 'line 1\nline 2', bytes: 13 }],
  });
  assert.match(request?.text ?? '', /^abcxyz/);
  assert.match(request?.text ?? '', /filename="messages\.txt"/);
  assert.match(request?.text ?? '', /line 1\nline 2/);
});

test('small text is decoded with BOM removed and binary is rejected', () => {
  assert.equal(decodeTextAttachment(Buffer.from('\ufeffhello\n', 'utf8')), 'hello\n');
  assert.equal(decodeTextAttachment(Buffer.from([0, 1, 2, 3])), null);
});

test('filenames are traversal-safe and duplicate paths never overwrite', () => {
  const sanitized = sanitizeFilename('../../evil.txt');
  assert.ok(!sanitized.includes('/'));
  assert.ok(!sanitized.startsWith('.'));
  const a = buildTempAttachmentPath('../../session', '../message', '../../evil.txt', 'same');
  const b = buildTempAttachmentPath('../../session', '../message', '../../evil.txt', 'same');
  assert.notEqual(a, b);
  assert.ok(a.includes('clauderemote'));
  assert.ok(!a.endsWith('/evil.txt'));
});

test('large text and binary path references are normalized without inlining', () => {
  const request = normalizeDiscordRequest({
    ...base,
    content: '',
    fileAttachments: [
      { name: 'large.log', path: '/tmp/large.log', bytes: 999999, kind: 'text' },
      { name: 'audio.mp3', path: '/tmp/audio.mp3', bytes: 1234, kind: 'binary' },
    ],
  });
  assert.match(request?.text ?? '', /large\.log: \/tmp\/large\.log/);
  assert.match(request?.text ?? '', /audio\.mp3: \/tmp\/audio\.mp3/);
});
