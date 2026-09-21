/**
 * Decompiler execution profiles.
 *
 * Provides pre-tuned budget configurations for different use cases:
 * - 'fast': Interactive binary exploration, game reverse engineering, rapid function hopping.
 * - 'deep': Comprehensive proof-oriented decompilation (default).
 */

export const DECOMPILER_PROFILES = Object.freeze({
  fast: Object.freeze({
    name: 'fast',
    decompilerTimeBudgetMs: 30,
    phase8TimeBudgetMs: 30,
    phase8WorkBudget: 10000,
    renderProvenanceBudget: Object.freeze({ maxTransformRecords: 128 }),
    renderProvenanceBindingBudget: Object.freeze({ maxConsumers: 256 }),
  }),
  deep: Object.freeze({
    name: 'deep',
    decompilerTimeBudgetMs: 250,
    phase8TimeBudgetMs: null,
    phase8WorkBudget: null,
    renderProvenanceBudget: null,
    renderProvenanceBindingBudget: null,
  }),
});

/**
 * Resolve a profile name to its preset settings.
 * Defaults to 'deep' if unspecified or unknown.
 */
export function resolveDecompilerProfile(profileName) {
  if (typeof profileName !== 'string') return DECOMPILER_PROFILES.deep;
  const key = profileName.trim().toLowerCase();
  return DECOMPILER_PROFILES[key] || DECOMPILER_PROFILES.deep;
}

/**
 * Apply profile defaults to an options object, respecting caller's explicit overrides.
 */
export function applyDecompilerProfile(opts = {}) {
  const profile = resolveDecompilerProfile(opts.profile);
  return {
    ...opts,
    decompilerTimeBudgetMs: opts.decompilerTimeBudgetMs ?? profile.decompilerTimeBudgetMs,
    phase8TimeBudgetMs: opts.phase8TimeBudgetMs ?? profile.phase8TimeBudgetMs,
    phase8WorkBudget: opts.phase8WorkBudget ?? profile.phase8WorkBudget,
    renderProvenanceBudget: opts.renderProvenanceBudget ?? profile.renderProvenanceBudget,
    renderProvenanceBindingBudget: opts.renderProvenanceBindingBudget ?? profile.renderProvenanceBindingBudget,
  };
}
