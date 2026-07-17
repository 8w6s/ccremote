import { Guild, GuildMember, Role } from 'discord.js';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const EFFORT_PRESETS: Record<
  EffortLevel,
  { label: string; color: number; native: EffortLevel }
> = {
  low: { label: 'Low', color: 0xf1c40f, native: 'low' },
  medium: { label: 'Medium', color: 0x2ecc71, native: 'medium' },
  high: { label: 'High', color: 0x00ffff, native: 'high' },
  xhigh: { label: 'XHigh', color: 0xc084fc, native: 'xhigh' },
  max: { label: 'Max', color: 0xe74c3c, native: 'max' },
  ultracode: { label: 'Ultracode', color: 0x6d28d9, native: 'max' },
};

const LEGACY_MODE_ROLE_NAMES = [
  'bypassPermissions',
  'auto',
  'manual',
  'acceptEdits',
  'plan',
] as const;
const LEGACY_EFFORT_PREFIX = 'clauderemote · effort · ';

function isLegacyModeRole(name: string): boolean {
  return LEGACY_MODE_ROLE_NAMES.some((mode) => name.endsWith(` [${mode}]`));
}

async function getOrCreateEffortRole(guild: Guild, level: EffortLevel): Promise<Role> {
  const name = level;
  let existing = guild.roles.cache.find((role) => role.name === name);
  if (!existing) {
    await guild.roles.fetch().catch(() => null);
    existing = guild.roles.cache.find((role) => role.name === name);
  }
  if (existing) {
    const color = EFFORT_PRESETS[level].color;
    if (existing.color !== color) await existing.setColor(color);
    await raiseBelowBot(existing);
    return existing;
  }
  const role = await guild.roles.create({
    name,
    color: EFFORT_PRESETS[level].color,
    reason: 'clauderemote thinking effort status',
  });
  await raiseBelowBot(role);
  return role;
}

async function raiseBelowBot(role: Role): Promise<void> {
  const botMember = role.guild.members.me;
  if (!botMember || botMember.roles.highest.position <= 1) return;
  const target = botMember.roles.highest.position - 1;
  if (role.position !== target) await role.setPosition(target);
}

export async function syncEffortRole(
  member: GuildMember,
  level: EffortLevel | null,
  _mode = 'bypassPermissions',
): Promise<void> {
  await member.guild.roles.fetch().catch(() => null);
  const roles = new Map<EffortLevel, Role>();
  for (const effortLevel of EFFORT_LEVELS) {
    roles.set(effortLevel, await getOrCreateEffortRole(member.guild, effortLevel));
  }

  const oldRoles = member.roles.cache.filter((role) =>
    EFFORT_LEVELS.includes(role.name as EffortLevel) ||
    LEGACY_MODE_ROLE_NAMES.includes(role.name as (typeof LEGACY_MODE_ROLE_NAMES)[number]) ||
    role.name.startsWith(LEGACY_EFFORT_PREFIX) ||
    isLegacyModeRole(role.name),
  );
  if (oldRoles.size > 0) await member.roles.remove(oldRoles, 'clauderemote effort changed');
  if (level) await member.roles.add(roles.get(level)!, 'clauderemote active thinking effort');
}

export async function clearEffortRoles(member: GuildMember): Promise<void> {
  const roles = member.roles.cache.filter(
    (role) =>
      LEGACY_MODE_ROLE_NAMES.includes(role.name as (typeof LEGACY_MODE_ROLE_NAMES)[number]) ||
      role.name.startsWith(LEGACY_EFFORT_PREFIX) ||
      isLegacyModeRole(role.name),
  );
  if (roles.size > 0) {
    await member.roles.remove(roles, 'clauderemote status roles belong to bot');
  }
}
