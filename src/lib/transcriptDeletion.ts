import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export interface StagedTranscriptDeletion {
  originalPath: string;
  quarantinePath: string;
}

/** Atomically hide a transcript while a multi-system delete is in progress. */
export function stageTranscriptDeletion(path: string): StagedTranscriptDeletion | null {
  if (!existsSync(path)) return null;
  const staged = {
    originalPath: path,
    quarantinePath: `${path}.clauderemote-delete-${randomUUID()}`,
  };
  renameSync(staged.originalPath, staged.quarantinePath);
  return staged;
}

/** Restore a staged transcript when Discord deletion fails. */
export function rollbackTranscriptDeletion(staged: StagedTranscriptDeletion): void {
  if (!existsSync(staged.quarantinePath)) return;
  renameSync(staged.quarantinePath, staged.originalPath);
}

/** Permanently remove a staged transcript after Discord confirms deletion. */
export function commitTranscriptDeletion(staged: StagedTranscriptDeletion): void {
  unlinkSync(staged.quarantinePath);
}
