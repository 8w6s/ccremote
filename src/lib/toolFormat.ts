/**
 * Format tool_use headers and results in the Claude Code CLI style:
 *   ● ${icon} **${name}** \`${primaryParam}\`
 *     ⎿ ${resultSummary}
 *
 * Reference: `docs.claude.com` + live CLI capture.
 */

export interface ToolFormat {
  icon: string;
  label: string; // User-facing tool name; may differ from the protocol name.
  primary: string; // Primary argument, such as a command or file path.
  subtext?: string; // Secondary context rendered below the primary argument.
}

/**
 */
function trunc(s: string, max = 120): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return s.slice(0, half) + '…' + s.slice(-half);
}

/**
 */
export function formatToolUse(name: string, input: Record<string, unknown>): ToolFormat {
  const get = (k: string): string => {
    const v = input?.[k];
    return typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
  };

  switch (name) {
    case 'Bash': {
      const cmd = get('command');
      const bg = input?.run_in_background === true ? ' &' : '';
      const desc = get('description');
      return {
        icon: '🖥️',
        label: 'Bash',
        primary: `$ ${trunc(cmd, 200)}${bg}`,
        subtext: desc || undefined,
      };
    }
    case 'BashOutput': {
      const shellId = get('bash_id') || get('shell_id');
      const filter = get('filter');
      return {
        icon: '📟',
        label: 'BashOutput',
        primary: shellId.slice(0, 8),
        subtext: filter ? `filter: ${filter}` : undefined,
      };
    }
    case 'KillShell':
    case 'KillBash': {
      return { icon: '⏹️', label: 'KillShell', primary: get('shell_id').slice(0, 8) };
    }
    case 'Read': {
      const p = get('file_path');
      const offset = input?.offset;
      const limit = input?.limit;
      const sub =
        offset != null || limit != null
          ? `lines ${offset ?? 0}–${(Number(offset) || 0) + (Number(limit) || 0)}`
          : undefined;
      return { icon: '📖', label: 'Read', primary: p, subtext: sub };
    }
    case 'Write': {
      return { icon: '📝', label: 'Write', primary: get('file_path') };
    }
    case 'Edit': {
      return {
        icon: '✏️',
        label: 'Update',
        primary: get('file_path'),
        subtext: input?.replace_all ? 'replace_all' : undefined,
      };
    }
    case 'NotebookEdit': {
      return {
        icon: '📓',
        label: 'NotebookEdit',
        primary: `${get('notebook_path')} · cell ${get('cell_id').slice(0, 8)}`,
        subtext: `edit_mode:${get('edit_mode') || 'replace'}`,
      };
    }
    case 'Grep': {
      const pattern = get('pattern');
      const path = get('path');
      const mode = get('output_mode');
      return {
        icon: '🔍',
        label: 'Search',
        primary: `"${trunc(pattern, 80)}"${path ? ` in ${path}` : ''}`,
        subtext: mode ? `mode:${mode}` : undefined,
      };
    }
    case 'Glob': {
      return { icon: '📁', label: 'Glob', primary: get('pattern') };
    }
    case 'WebFetch': {
      return {
        icon: '🌐',
        label: 'Fetch',
        primary: trunc(get('url'), 90),
        subtext: get('prompt') || undefined,
      };
    }
    case 'WebSearch': {
      return { icon: '🔎', label: 'WebSearch', primary: `"${trunc(get('query'), 90)}"` };
    }
    case 'TodoWrite': {
      const todos = Array.isArray(input?.todos) ? (input.todos as unknown[]) : [];
      return { icon: '☑️', label: 'Todos', primary: `${todos.length} items` };
    }
    case 'Task':
    case 'Agent': {
      return {
        icon: '🤖',
        label: name,
        primary: get('subagent_type') || 'agent',
        subtext: get('description'),
      };
    }
    case 'SlashCommand': {
      return { icon: '/', label: 'SlashCommand', primary: get('command') };
    }
    case 'ExitPlanMode': {
      return { icon: '📤', label: 'ExitPlanMode', primary: 'exit plan' };
    }
    default: {
      // MCP tool names use either "server:tool" or mcp__server__tool.
      if (name.startsWith('mcp__') || name.includes(':')) {
        const short = name.replace(/^mcp__/, '').replace(/__/g, ':');
        const preview = trunc(JSON.stringify(input ?? {}), 100);
        return { icon: '🔌', label: short, primary: preview };
      }
      // Unknown tool → generic
      const preview = trunc(JSON.stringify(input ?? {}), 100);
      return { icon: '🔧', label: name, primary: preview };
    }
  }
}

/**
 */
export interface ResultRender {
  summary: string; // Compact result summary.
  body?: string; // block ``` output preview
  truncated?: boolean;
  totalBytes?: number;
}

const RESULT_PREVIEW_LINES = 18;
const RESULT_PREVIEW_MAX_CHARS = 1500;

export function formatToolResult(
  toolName: string,
  output: string,
  isError: boolean,
  durationMs?: number,
): ResultRender {
  if (isError) {
    const body = output.length > RESULT_PREVIEW_MAX_CHARS
      ? output.slice(0, RESULT_PREVIEW_MAX_CHARS) + '\n… (truncated)'
      : output;
    return {
      summary: `Error${durationMs ? ` · ${durationMs}ms` : ''}`,
      body,
      truncated: output.length > RESULT_PREVIEW_MAX_CHARS,
      totalBytes: output.length,
    };
  }

  const lines = output.split('\n');
  const totalLines = lines.length;

  // Per-tool summary
  let summary: string;
  switch (toolName) {
    case 'Bash':
      summary = `Ran command${durationMs ? ` (${durationMs}ms)` : ''} · ${totalLines} lines`;
      break;
    case 'Read':
      summary = `Read ${totalLines} lines`;
      break;
    case 'Write':
      summary = `Wrote ${totalLines} lines`;
      break;
    case 'Edit':
    case 'NotebookEdit':
      summary = `Updated`;
      break;
    case 'Grep':
      summary = `Found ${totalLines} matches`;
      break;
    case 'Glob':
      summary = `Found ${totalLines} entries`;
      break;
    case 'WebFetch':
      summary = `Fetched ${output.length} bytes`;
      break;
    case 'WebSearch':
      summary = `Search complete`;
      break;
    case 'TodoWrite':
      summary = `Updated todos`;
      break;
    case 'Task':
    case 'Agent':
      summary = `Subagent complete`;
      break;
    default:
      summary = `Done${durationMs ? ` (${durationMs}ms)` : ''}`;
  }

  let body: string | undefined;
  let truncated = false;
  if (output.trim().length > 0) {
    if (totalLines <= RESULT_PREVIEW_LINES && output.length <= RESULT_PREVIEW_MAX_CHARS) {
      body = output;
    } else {
      // head 12 + tail 6
      const head = lines.slice(0, 12).join('\n');
      const tail = lines.slice(-6).join('\n');
      body = `${head}\n… (${totalLines - 18} lines) …\n${tail}`;
      if (body.length > RESULT_PREVIEW_MAX_CHARS) {
        body = body.slice(0, RESULT_PREVIEW_MAX_CHARS) + '\n… (further truncated)';
      }
      truncated = true;
    }
  }

  return { summary, body, truncated, totalBytes: output.length };
}
