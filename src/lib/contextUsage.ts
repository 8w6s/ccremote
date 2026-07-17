export interface ContextUsageView {
  model?: string;
  usedTokens: number;
  maxTokens: number;
  usedPercent: number;
  skillsTokens: number;
  skillsPercent: number;
  contextTokens: number;
  contextPercent: number;
  freeTokens: number;
  freePercent: number;
  grid: string;
}

const GRID_CELLS = 50;

export function parseCompactTokenCount(raw: string): number | null {
  const match = raw.trim().match(/^([\d.]+)\s*([kKmM])?$/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2]?.toLowerCase();
  return Math.round(value * (unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1));
}

function category(raw: string, label: string): { tokens: number; percent: number } | null {
  const expression = new RegExp(
    `${label}\\s*:\\s*([\\d.]+\\s*[kKmM]?)\\s*tokens?\\s*\\(([\\d.]+)%\\)`,
    'i',
  );
  const match = raw.match(expression);
  if (!match) return null;
  const tokens = parseCompactTokenCount(match[1]);
  const percent = Number(match[2]);
  if (tokens == null || !Number.isFinite(percent)) return null;
  return { tokens, percent };
}

function cells(percent: number): number {
  return Math.max(0, Math.min(GRID_CELLS, Math.round((percent / 100) * GRID_CELLS)));
}

function alternating(count: number, a: string, b: string): string {
  return Array.from({ length: count }, (_, index) => index % 2 === 0 ? a : b).join('');
}

export function parseContextUsage(raw: string): ContextUsageView | null {
  const total = raw.match(
    /([\d.]+\s*[kKmM]?)\s*\/\s*([\d.]+\s*[kKmM]?)\s*tokens?\s*\(([\d.]+)%\)/i,
  );
  if (!total) return null;
  const usedTokens = parseCompactTokenCount(total[1]);
  const maxTokens = parseCompactTokenCount(total[2]);
  const usedPercent = Number(total[3]);
  if (usedTokens == null || maxTokens == null || !Number.isFinite(usedPercent)) return null;

  const skills = category(raw, 'Skills') ?? { tokens: 0, percent: 0 };
  const explicitFree = category(raw, 'Free space');
  const freePercent = explicitFree?.percent ?? Math.max(0, 100 - usedPercent);
  const freeTokens = explicitFree?.tokens ?? Math.max(0, maxTokens - usedTokens);
  // Everything used except skill descriptions is grouped as Context. This
  // remains stable when Claude adds new categories such as memory or MCP.
  const contextPercent = Math.max(0, usedPercent - skills.percent);
  const contextTokens = Math.max(0, usedTokens - skills.tokens);

  let skillCells = cells(skills.percent);
  let contextCells = cells(contextPercent);
  if (skillCells + contextCells > GRID_CELLS) {
    contextCells = Math.max(0, GRID_CELLS - skillCells);
  }
  const freeCells = Math.max(0, GRID_CELLS - skillCells - contextCells);
  // Preserve a visible skill marker when Claude reports a non-zero skill
  // category smaller than one grid cell.
  if (skills.tokens > 0 && skillCells === 0 && freeCells > 0) skillCells = 1;
  const normalizedFree = Math.max(0, GRID_CELLS - skillCells - contextCells);
  const grid =
    alternating(skillCells, '⛀', '⛁') +
    alternating(contextCells, '⛂', '⛃') +
    '⛶'.repeat(normalizedFree);

  const model = raw.match(/^\s*([^\n]+?)\s*\([^\n]*context\)\s*$/im)?.[1]?.trim();
  return {
    model,
    usedTokens,
    maxTokens,
    usedPercent,
    skillsTokens: skills.tokens,
    skillsPercent: skills.percent,
    contextTokens,
    contextPercent,
    freeTokens,
    freePercent,
    grid,
  };
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(tokens);
}
