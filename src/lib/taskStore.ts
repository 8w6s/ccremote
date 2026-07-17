import type { TodoItem } from './renderer';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

interface StoredTask extends TodoItem {
  id: string;
  description?: string;
}

const tasksByChannel = new Map<string, Map<string, StoredTask>>();
const hydrateInflight = new Map<string, Promise<void>>();

function store(channelId: string): Map<string, StoredTask> {
  let tasks = tasksByChannel.get(channelId);
  if (!tasks) {
    tasks = new Map();
    tasksByChannel.set(channelId, tasks);
  }
  return tasks;
}

export function replaceTodos(channelId: string, todos: TodoItem[]): void {
  const next = new Map<string, StoredTask>();
  todos.forEach((todo, index) => next.set(String(index + 1), { ...todo, id: String(index + 1) }));
  tasksByChannel.set(channelId, next);
}

export function applyTaskTool(
  channelId: string,
  name: string,
  input: Record<string, unknown>,
  toolUseId: string,
): void {
  const tasks = store(channelId);
  if (name === 'TaskCreate') {
    const id = `pending:${toolUseId}`;
    tasks.set(id, {
      id,
      content: String(input.subject ?? input.task_subject ?? 'New task'),
      description: typeof input.description === 'string' ? input.description : undefined,
      activeForm: typeof input.activeForm === 'string' ? input.activeForm : undefined,
      status: 'pending',
    });
  } else if (name === 'TaskUpdate') {
    const id = String(input.taskId ?? input.task_id ?? '');
    const current = tasks.get(id);
    if (!id || (!current && input.status === 'deleted')) return;
    if (input.status === 'deleted') {
      tasks.delete(id);
      return;
    }
    tasks.set(id, {
      id,
      content: String(input.subject ?? current?.content ?? `Task ${id}`),
      description: typeof input.description === 'string' ? input.description : current?.description,
      activeForm: typeof input.activeForm === 'string' ? input.activeForm : current?.activeForm,
      status:
        input.status === 'completed' || input.status === 'in_progress'
          ? input.status
          : current?.status ?? 'pending',
    });
  }
}

export function finalizeTaskCreate(channelId: string, toolUseId: string, output: string): void {
  const tasks = store(channelId);
  const tempId = `pending:${toolUseId}`;
  const task = tasks.get(tempId);
  if (!task) return;
  const match = output.match(/(?:task[_ ]?id|#)\s*[:=]?\s*["']?([\w-]+)/i);
  if (!match?.[1]) return;
  tasks.delete(tempId);
  tasks.set(match[1], { ...task, id: match[1] });
}

export function getTasks(channelId: string): StoredTask[] {
  return [...(tasksByChannel.get(channelId)?.values() ?? [])];
}

export async function hydrateTasksFromJsonl(channelId: string, jsonlPath: string): Promise<void> {
  const existing = hydrateInflight.get(channelId);
  if (existing) return existing;
  const promise = (async () => {
    const pendingCreates = new Set<string>();
    const lines = createInterface({ input: createReadStream(jsonlPath), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const message = event.message as { content?: unknown } | undefined;
      if (!Array.isArray(message?.content)) continue;
      for (const rawBlock of message.content) {
        if (!rawBlock || typeof rawBlock !== 'object') continue;
        const block = rawBlock as Record<string, unknown>;
        if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          if (block.name === 'TaskCreate' || block.name === 'TaskUpdate') {
            applyTaskTool(channelId, block.name, (block.input as Record<string, unknown>) ?? {}, block.id);
            if (block.name === 'TaskCreate') pendingCreates.add(block.id);
          } else if (block.name === 'TodoWrite') {
            const input = (block.input as Record<string, unknown>) ?? {};
            replaceTodos(channelId, Array.isArray(input.todos) ? input.todos as TodoItem[] : []);
          }
        } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && pendingCreates.has(block.tool_use_id)) {
          const output = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
          finalizeTaskCreate(channelId, block.tool_use_id, output);
          pendingCreates.delete(block.tool_use_id);
        }
      }
    }
  })();
  hydrateInflight.set(channelId, promise);
  try { await promise; } finally { hydrateInflight.delete(channelId); }
}
