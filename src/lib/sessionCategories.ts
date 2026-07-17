export interface SessionCategoryConfig {
  active: string;
  background?: string;
  archive?: string;
}

export function isLiveSessionCategory(
  parentId: string | null,
  categories: SessionCategoryConfig,
): boolean {
  if (!parentId) return false;
  return parentId === categories.active ||
    (Boolean(categories.background) && parentId === categories.background);
}

export function isKnownSessionCategory(
  parentId: string | null,
  categories: SessionCategoryConfig,
): boolean {
  return isLiveSessionCategory(parentId, categories) ||
    (Boolean(categories.archive) && parentId === categories.archive);
}
