export interface InlineTextAttachment {
  name: string;
  text: string;
  bytes: number;
}

export interface FileAttachmentRef {
  name: string;
  path: string;
  bytes: number;
  kind: 'text' | 'binary';
}

export interface NormalizedDiscordRequest {
  text: string;
  inlineAttachments: InlineTextAttachment[];
  fileAttachments: FileAttachmentRef[];
  sourceMessageId: string;
  channelId: string;
  sessionUuid: string | null;
}

const CUSTOM_EMOJI = /<a?:[A-Za-z0-9_]{1,64}:\d{2,}>/g;

export function stripCustomDiscordEmoji(input: string): string {
  return input.replace(CUSTOM_EMOJI, '').replace(/[ \t]+\n/g, '\n').trim();
}

function inlineBlock(attachment: InlineTextAttachment): string {
  // The byte length makes the delimiter unambiguous even if file content
  // itself contains XML-looking text. Content remains byte-for-byte decoded.
  return `<attachment filename="${attachment.name}" bytes="${attachment.bytes}">\n${attachment.text}\n</attachment>`;
}

function fileBlock(file: FileAttachmentRef): string {
  return `Attached ${file.kind} file:\n- ${file.name}: ${file.path} (${file.bytes} bytes)`;
}

export function normalizeDiscordRequest(input: {
  content: string;
  replyContext?: string | null;
  inlineAttachments?: InlineTextAttachment[];
  fileAttachments?: FileAttachmentRef[];
  hasInlineImages?: boolean;
  stickerCount?: number;
  sourceMessageId: string;
  channelId: string;
  sessionUuid: string | null;
}): NormalizedDiscordRequest | null {
  const visible = stripCustomDiscordEmoji(input.content);
  const inlineAttachments = input.inlineAttachments ?? [];
  const fileAttachments = input.fileAttachments ?? [];
  const sections: string[] = [];
  if (input.replyContext?.trim()) sections.push(input.replyContext.trim());
  if (visible) sections.push(visible);
  sections.push(...inlineAttachments.map(inlineBlock));
  sections.push(...fileAttachments.map(fileBlock));
  if (sections.length === 0 && !input.hasInlineImages) return null;
  return {
    text: sections.join('\n\n'),
    inlineAttachments,
    fileAttachments,
    sourceMessageId: input.sourceMessageId,
    channelId: input.channelId,
    sessionUuid: input.sessionUuid,
  };
}
