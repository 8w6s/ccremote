import { Message } from 'discord.js';

/**
 * Ignore embeds and controls; quote only bounded plain content and author name.
 */
export async function fetchReplyContext(msg: Message): Promise<string | null> {
  const refId = msg.reference?.messageId;
  if (!refId) return null;
  const referenced = await msg.channel.messages.fetch(refId).catch(() => null);
  if (!referenced) return null;

  const author = referenced.author?.username ?? 'user';
  let content = referenced.content?.trim() ?? '';

  // Fallback: extract bounded text from components.
  if (!content && referenced.components?.length) {
    // Best effort: stringify and extract content fields.
    try {
      const raw = JSON.stringify(referenced.components);
      const matches = raw.match(/"content":"([^"\\]|\\.){0,600}"/g) ?? [];
      const parts = matches
        .map((m) => {
          try {
            return JSON.parse(`{${m}}`).content as string;
          } catch {
            return '';
          }
        })
        .filter(Boolean);
      content = parts.join('\n').slice(0, 1200);
    } catch {
      content = '';
    }
  }

  if (!content) return null;
  const lines = content
    .split('\n')
    .slice(0, 20)
    .map((l) => `> ${l}`)
    .join('\n');
  return `[Reply to @${author}]\n${lines}`;
}
