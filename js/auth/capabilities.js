/** HEX roles are labels, never a numeric hierarchy. Discord is identity only. */
export const HEX_ROLES = Object.freeze(['free', 'vip', 'admin']);
const standard = Object.freeze({ canUseStandardAgent: true, canUseDevAgent: false, canUseDevYolo: false, canManageUsers: false, canFetchPrivilegedDevSource: false });
const admin = Object.freeze(Object.fromEntries(Object.keys(standard).map((key) => [key, true])));
const roleCapabilities = Object.freeze({ free: standard, vip: standard, admin });
export const ANONYMOUS_IDENTITY = Object.freeze({ authenticated: false, discordId: null, username: null, role: null, enabled: false, owner: false, admin: false, provider: 'hex-session', capabilities: standard });

export function capabilitiesFor({ role, enabled = false, owner = false } = {}) {
  if (owner === true) return admin;
  return enabled === true && HEX_ROLES.includes(role) ? roleCapabilities[role] : standard;
}

/** Call only with a freshly read D1 row. No client role snapshots are accepted. */
export function identityForUser(user, ownerId) {
  if (!user) return ANONYMOUS_IDENTITY;
  const owner = !!ownerId && user.discord_id === ownerId;
  const enabled = owner || user.enabled === 1;
  if (!enabled || (!owner && !HEX_ROLES.includes(user.role))) return ANONYMOUS_IDENTITY;
  const role = owner ? 'admin' : user.role;
  const capabilities = capabilitiesFor({ role, enabled, owner });
  return Object.freeze({ authenticated: true, discordId: user.discord_id, username: user.username ?? null, role, enabled, owner, admin: role === 'admin', provider: 'hex-session', capabilities });
}

/** Whitelist fields crossing the parent/child boundary; never spread a session. */
export function safeIdentity(value) {
  if (!value || value.authenticated !== true || typeof value.discordId !== 'string' || !HEX_ROLES.includes(value.role) || value.enabled !== true) return ANONYMOUS_IDENTITY;
  const policy = capabilitiesFor({ role: value.role, enabled: true });
  const capabilities = Object.freeze(Object.fromEntries(Object.keys(standard).map((key) => [key, key === 'canUseStandardAgent' || (policy[key] && value.capabilities?.[key] === true)])));
  return Object.freeze({ authenticated: true, discordId: value.discordId, username: typeof value.username === 'string' ? value.username.slice(0, 128) : null, role: value.role, enabled: true, owner: value.owner === true, admin: value.role === 'admin', provider: 'hex-session', capabilities });
}
