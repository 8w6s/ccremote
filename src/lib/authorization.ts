import { OverwriteType, PermissionsBitField } from 'discord.js';
import { config } from '../config';
import { isTeamMember } from './team';

type PermissionTarget = {
  permissionOverwrites?: {
    cache: Map<string, {
      type: OverwriteType;
      allow: PermissionsBitField;
    }>;
  };
};

/** Owner/team access plus explicit member access granted by `/handoff`. */
export function isAuthorizedUser(userId: string, channel?: unknown): boolean {
  if (userId === config.ownerId || isTeamMember(userId)) return true;
  if (!channel || typeof channel !== 'object') return false;
  const raw = channel as PermissionTarget & { isThread?: () => boolean; parent?: unknown };
  const target = raw.isThread?.() ? raw.parent as PermissionTarget | undefined : raw;
  const overwrite = target?.permissionOverwrites?.cache.get(userId);
  return overwrite?.type === OverwriteType.Member &&
    overwrite.allow.has(PermissionsBitField.Flags.ViewChannel) &&
    overwrite.allow.has(PermissionsBitField.Flags.SendMessages);
}

/** Permanent local-data deletion is never delegated through team or handoff access. */
export function canPermanentlyDelete(userId: string): boolean {
  return userId === config.ownerId;
}
