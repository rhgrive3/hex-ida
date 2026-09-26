/**
 * Decompiler execution profiles.
 *
 * Provides pre-tuned budget configurations for different use cases:
 * - 'fast': Interactive binary exploration, game reverse engineering, rapid function hopping (default).
 * - 'deep': Comprehensive proof-oriented decompilation.
 */

export const DECOMPILER_PROFILES = Object.freeze({
  fast: Object.freeze({
    name: 'fast',
    // Fast is bounded by deterministic work budgets during normal operation.
    // This monotonic deadline is a last-resort safety ceiling, not the primary
    // limiter. Explicit caller time budgets still take precedence.
    decompilerTimeBudgetMs: null,
    transformSafetyCeilingMs: 2000,
    phase8TimeBudgetMs: null,
    phase8WorkBudget: 10000,
    renderProvenanceBudget: Object.freeze({ maxTransformRecords: 128 }),
    renderProvenanceBindingBudget: Object.freeze({ maxConsumers: 256 }),
  }),
  deep: Object.freeze({
    name: 'deep',
    decompilerTimeBudgetMs: 250,
    transformSafetyCeilingMs: null,
    phase8TimeBudgetMs: null,
    phase8WorkBudget: null,
    renderProvenanceBudget: null,
    renderProvenanceBindingBudget: null,
  }),
});

function clock(opts = {}) {
  if (typeof opts.transformClock === 'function') return opts.transformClock();
  return globalThis.performance?.now ? globalThis.performance.now() : Date.now();
}

function deadlineDuration(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function safetyCeiling(value) {
  return Math.min(deadlineDuration(value), 2000);
}

/**
 * Resolve a profile name to its preset settings.
 * Defaults to 'fast' if unspecified or unknown.
 */
export function resolveDecompilerProfile(profileName) {
  if (typeof profileName !== 'string') return DECOMPILER_PROFILES.fast;
  const key = profileName.trim().toLowerCase();
  return DECOMPILER_PROFILES[key] || DECOMPILER_PROFILES.fast;
}

/**
 * Apply profile defaults to an options object, respecting caller's explicit overrides.
 */
export function applyDecompilerProfile(opts = {}) {
  const profile = resolveDecompilerProfile(opts.profile);
  const decompilerTimeBudgetMs = opts.decompilerTimeBudgetMs ?? profile.decompilerTimeBudgetMs;
  const transformSafetyCeilingMs = opts.transformSafetyCeilingMs ?? profile.transformSafetyCeilingMs;
  const fastTimedTransforms = profile.name === 'fast' && opts.deterministicTransforms !== true;
  const deadlineMs = opts.decompilerTimeBudgetMs != null
    ? opts.decompilerTimeBudgetMs
    : transformSafetyCeilingMs;
  const transformDeadline = fastTimedTransforms && deadlineMs != null
    ? (typeof opts.transformDeadline === 'number' && Number.isFinite(opts.transformDeadline)
      ? opts.transformDeadline
      : clock(opts) + (opts.decompilerTimeBudgetMs != null
        ? deadlineDuration(deadlineMs)
        : safetyCeiling(deadlineMs)))
    : null;
  return {
    ...opts,
    decompilerTimeBudgetMs,
    transformSafetyCeilingMs: transformSafetyCeilingMs == null
      ? null
      : safetyCeiling(transformSafetyCeilingMs),
    transformDeadline,
    transformDeadlineReason: transformDeadline == null
      ? null
      : opts.decompilerTimeBudgetMs != null ? 'transform-time-budget' : 'transform-safety-ceiling',
    phase8TimeBudgetMs: opts.phase8TimeBudgetMs ?? profile.phase8TimeBudgetMs,
    phase8WorkBudget: opts.phase8WorkBudget ?? profile.phase8WorkBudget,
    renderProvenanceBudget: opts.renderProvenanceBudget ?? profile.renderProvenanceBudget,
    renderProvenanceBindingBudget: opts.renderProvenanceBindingBudget ?? profile.renderProvenanceBindingBudget,
  };
}
