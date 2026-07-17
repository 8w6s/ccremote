export type InteractionEvent =
  | { type: 'UserPrompt'; text: string; source: 'discord' | 'cli-local' }
  | { type: 'AssistantTextDelta'; text: string; parentToolUseId?: string }
  | { type: 'AssistantTextEnd'; parentToolUseId?: string }
  | { type: 'ToolUse'; toolUseId: string; name: string; input: Record<string, unknown>; parentToolUseId?: string }
  | { type: 'ToolResult'; toolUseId: string; output: string; isError: boolean; parentToolUseId?: string }
  | { type: 'TaskListUpdate'; toolUseId: string; name: 'TaskCreate' | 'TaskUpdate' | 'TodoWrite'; input: Record<string, unknown> }
  | { type: 'ToolRunningStatus'; toolUseId: string; name: string; input: Record<string, unknown> }
  | { type: 'ErrorEvent'; title: string; detail?: string }
  | { type: 'WarningEvent'; title: string; detail?: string };

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && 'text' in part) return String(part.text ?? '');
    return '';
  }).join('\n');
}

/** Defensive JSONL adapter. Unknown/internal/thinking events intentionally vanish. */
export function normalizeJsonlEvent(raw: unknown): InteractionEvent[] {
  if (!raw || typeof raw !== 'object') return [];
  const event = raw as Record<string, unknown>;
  const message = event.message as { content?: unknown } | undefined;
  if (event.type === 'user') {
    if (typeof message?.content === 'string') {
      return [{ type: 'UserPrompt', text: message.content, source: 'cli-local' }];
    }
    if (!Array.isArray(message?.content)) return [];
    const output: InteractionEvent[] = [];
    for (const rawBlock of message.content) {
      if (!rawBlock || typeof rawBlock !== 'object') continue;
      const block = rawBlock as Record<string, unknown>;
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        output.push({
          type: 'ToolResult',
          toolUseId: block.tool_use_id,
          output: toolResultText(block.content),
          isError: block.is_error === true,
        });
      } else if (block.type === 'text' && typeof block.text === 'string') {
        output.push({ type: 'UserPrompt', text: block.text, source: 'cli-local' });
      }
    }
    return output;
  }
  if (event.type === 'assistant' && Array.isArray(message?.content)) {
    const output: InteractionEvent[] = [];
    for (const rawBlock of message.content) {
      if (!rawBlock || typeof rawBlock !== 'object') continue;
      const block = rawBlock as Record<string, unknown>;
      if (block.type === 'text' && typeof block.text === 'string') {
        output.push({ type: 'AssistantTextDelta', text: block.text });
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        output.push({
          type: 'ToolUse',
          toolUseId: block.id,
          name: block.name,
          input: block.input && typeof block.input === 'object' ? block.input as Record<string, unknown> : {},
        });
      }
    }
    output.push({ type: 'AssistantTextEnd' });
    return output;
  }
  return [];
}
