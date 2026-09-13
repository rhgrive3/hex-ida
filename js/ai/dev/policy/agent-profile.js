export const AGENT_PROFILE = Object.freeze({ STANDARD: 'standard', DEV: 'dev' });
export const AGENT_PROFILES = Object.freeze(Object.values(AGENT_PROFILE));

export function assertAgentProfile(value) {
  if (typeof value !== 'string') {
    throw new TypeError(`Agent profile must be a string, got ${value === null ? 'null' : typeof value}`);
  }
  const profile = value.trim().toLowerCase();
  if (!AGENT_PROFILES.includes(profile)) throw new TypeError(`Unsupported agent profile: ${value}`);
  return profile;
}

function canUseDev(identity) {
  return identity?.capabilities?.canUseDevAgent === true || (identity?.capabilities == null && identity?.admin === true);
}

export function availableAgentProfiles(identity = {}) {
  return Object.freeze(canUseDev(identity)
    ? [AGENT_PROFILE.STANDARD, AGENT_PROFILE.DEV]
    : [AGENT_PROFILE.STANDARD]);
}

export function canSelectAgentProfile(identity, profile) {
  const normalized = assertAgentProfile(profile);
  return normalized === AGENT_PROFILE.STANDARD || canUseDev(identity);
}
