// Community permission bits
export const Permissions = {
  VIEW_CHANNELS:       1n << 0n,
  SEND_MESSAGES:       1n << 1n,
  MANAGE_MESSAGES:     1n << 2n,
  MANAGE_CHANNELS:     1n << 3n,
  MANAGE_ROLES:        1n << 4n,
  MANAGE_COMMUNITY:    1n << 5n,
  KICK_MEMBERS:        1n << 6n,
  BAN_MEMBERS:         1n << 7n,
  TIMEOUT_MEMBERS:     1n << 8n,
  MENTION_EVERYONE:    1n << 9n,
  ATTACH_FILES:        1n << 10n,
  CONNECT_VOICE:       1n << 11n,
  SPEAK:               1n << 12n,
  MANAGE_VOICE:        1n << 13n,
  EMBED_LINKS:         1n << 14n,
  READ_MESSAGE_HISTORY: 1n << 15n,
  ADD_REACTIONS:       1n << 16n,
  MANAGE_INVITES:      1n << 17n,
  VIEW_AUDIT_LOG:      1n << 18n,
  ADMINISTRATOR:       1n << 30n, // bypasses all channel checks
} as const;

export type PermissionKey = keyof typeof Permissions;

export const DEFAULT_PERMISSIONS =
  Permissions.VIEW_CHANNELS |
  Permissions.SEND_MESSAGES |
  Permissions.READ_MESSAGE_HISTORY |
  Permissions.ATTACH_FILES |
  Permissions.EMBED_LINKS |
  Permissions.ADD_REACTIONS |
  Permissions.CONNECT_VOICE |
  Permissions.SPEAK;

export function hasPermission(perms: bigint, flag: bigint): boolean {
  if ((perms & Permissions.ADMINISTRATOR) === Permissions.ADMINISTRATOR) {
    return true;
  }
  return (perms & flag) === flag;
}

export function addPermission(perms: bigint, flag: bigint): bigint {
  return perms | flag;
}

export function removePermission(perms: bigint, flag: bigint): bigint {
  return perms & ~flag;
}

export function computePermissions(rolePermissions: bigint[]): bigint {
  return rolePermissions.reduce((acc, p) => acc | p, 0n);
}

export function applyChannelOverrides(
  base: bigint,
  overrides: { allow: bigint; deny: bigint }[]
): bigint {
  let perms = base;
  for (const o of overrides) {
    perms = (perms & ~o.deny) | o.allow;
  }
  return perms;
}
