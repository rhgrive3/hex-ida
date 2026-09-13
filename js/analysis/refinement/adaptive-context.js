/** A bounded policy over the EXISTING conditional range owner. This table owns
 * scheduling statistics only, never semantic facts or another context cache.
 * Its grants live only in one demand session; resume does not reset quotas.
 */
import { snapshotContractData, recordFields, exactInteger, contractFail } from '../../core/identity/structured.js';
import { deepFreeze, stableStringify } from '../../core/identity/index.js';
import { assertSummarySpecialization } from '../summary/specialization.js';
import { assertScopedAnalysisWork } from '../../core/budgets/scoped-work.js';

export function normalizeAdaptiveContextPolicy(input) {
  if (input === undefined) return null;
  const value = snapshotContractData(input, { maxBytes: 4096, maxNodes: 32 });
  recordFields(value, ['enabled', 'maximumRefinements', 'maximumFamilies', 'warmupSamples', 'minimumGain', 'maximumMeasuredWork'], 'adaptive-policy-fields');
  if (value.enabled !== true) contractFail('adaptive-policy-explicit-opt-in');
  return deepFreeze({ enabled: true,
    maximumRefinements: exactInteger(value.maximumRefinements ?? 16, 'adaptive-refinements', { min: 0, max: 32 }),
    maximumFamilies: exactInteger(value.maximumFamilies ?? 16, 'adaptive-families', { min: 1, max: 32 }),
    warmupSamples: exactInteger(value.warmupSamples ?? 2, 'adaptive-warmup', { min: 1, max: 8 }),
    minimumGain: exactInteger(value.minimumGain ?? 1, 'adaptive-minimum-gain', { min: 0, max: 256 }),
    maximumMeasuredWork: exactInteger(value.maximumMeasuredWork ?? 1000000, 'adaptive-total-work', { min: 0, max: 8000000 }) });
}
function precisionRows(value) {
  const rows = new Map(), ambiguous = new Set();
  for (const row of value?.values ?? []) {
    if (!Number.isSafeInteger(row.localId) || row.localId < 0 || !row.fact || ambiguous.has(row.localId)) continue;
    if (rows.has(row.localId)) { rows.delete(row.localId); ambiguous.add(row.localId); continue; }
    rows.set(row.localId, { constant: row.fact.constant != null, rangeKind: row.fact.range?.kind ?? null });
  }
  return rows;
}
export class AdaptiveContextPolicy {
  #policy; #families = new Map(); #grants = new WeakMap(); #issued = 0; #measuredWork = 0; #closed = false;
  #receipts = []; #active = null;
  constructor(policy) { this.#policy = normalizeAdaptiveContextPolicy(policy); if (!this.#policy) contractFail('adaptive-policy-required'); }
  begin(specialization, baseline, { work } = {}) {
    assertScopedAnalysisWork(work); work.checkpoint(); assertSummarySpecialization(specialization);
    if (this.#closed || this.#active) contractFail('adaptive-policy-closed-or-busy');
    // Summary identity and positive source ownership, not a function name,
    // define the family. Distinct worlds, assumptions and SCC revisions cannot
    // share cost/benefit observations.
    const key = stableStringify([specialization.worldId, specialization.assumptionsId, specialization.snapshotId,
      specialization.functionId, specialization.sourceSummaryDigest, specialization.sccRevision,
      specialization.contextDependencyKey, specialization.dependencies.positiveArtifactIds]);
    let family = this.#families.get(key), reason = null;
    if (this.#issued >= this.#policy.maximumRefinements) reason = 'adaptive-refinement-count-limit';
    else if (this.#measuredWork >= this.#policy.maximumMeasuredWork) reason = 'adaptive-measured-work-limit';
    else if (!family && this.#families.size >= this.#policy.maximumFamilies) reason = 'adaptive-family-inventory-limit';
    else if (family?.samples >= this.#policy.warmupSamples && family.gain < this.#policy.minimumGain * family.samples) reason = 'adaptive-measured-gain-below-threshold';
    if (reason) return deepFreeze({ admitted: false, reason, contextId: specialization.id, canonicalTruthChanged: false });
    if (!family) { family = { samples: 0, incomplete: 0, gain: 0, workUnits: 0, bytesRead: 0, elapsedMs: 0 }; this.#families.set(key, family); }
    const grant = Object.freeze({});
    this.#grants.set(grant, { family, contextId: specialization.id, baseline: precisionRows(baseline),
      start: work.cost(), work, snapshotId: specialization.snapshotId, worldId: specialization.worldId });
    this.#active = grant; this.#issued++;
    return Object.freeze({ admitted: true, grant, contextId: specialization.id });
  }
  finish(grant, projected, { completed = true } = {}) {
    const pending = this.#grants.get(grant);
    if (this.#closed || !pending || this.#active !== grant) contractFail('adaptive-grant-unavailable');
    // Consume BEFORE inspecting results. Failure cannot replay a grant to
    // reset cost, duplicate a sample, or publish a partial outcome as measured.
    this.#grants.delete(grant); this.#active = null;
    const { family, start, work } = pending, end = work.cost();
    const cost = { workUnits: Math.max(0, (end.used.workUnits ?? 0) - (start.used.workUnits ?? 0)),
      bytesRead: Math.max(0, (end.used.bytesRead ?? 0) - (start.used.bytesRead ?? 0)), elapsedMs: Math.max(0, end.elapsedMs - start.elapsedMs) };
    this.#measuredWork += cost.workUnits; family.workUnits += cost.workUnits; family.bytesRead += cost.bytesRead; family.elapsedMs += cost.elapsedMs;
    const valid = completed === true && projected?.contextId === pending.contextId && projected.worldId === pending.worldId
      && projected.snapshotId === pending.snapshotId && projected.exact === false && projected.status === 'completed';
    let gain = null, compared = 0;
    if (valid) {
      gain = 0;
      for (const [id, row] of precisionRows(projected)) {
        const old = pending.baseline.get(id); if (!old) continue; compared++;
        if ((!old.constant && row.constant) || (old.rangeKind === 'full' && row.rangeKind && row.rangeKind !== 'full')) gain++;
      }
      // No common denominator is unmeasured, NOT a zero-benefit observation.
      if (compared) { family.samples++; family.gain += gain; } else { gain = null; family.incomplete++; }
    } else family.incomplete++;
    const receipt = deepFreeze({ schema: 'scpa-context-refinement-receipt/v1', contextId: pending.contextId,
      status: gain === null ? 'incomplete' : 'measured', gain, comparedValues: compared, cost,
      metric: 'conditional-owner-constant-or-nonfull-range-improvements; not-semantic-recall',
      canonicalTruthChanged: false, proofAuthority: false });
    this.#receipts.push(receipt); return receipt;
  }
  describe() {
    return deepFreeze({ schema: 'scpa-adaptive-context-policy/v1', policy: this.#policy, issuedRefinements: this.#issued,
      retainedFamilies: this.#families.size, measuredWorkUnits: this.#measuredWork,
      receipts: [...this.#receipts], active: this.#active !== null, semanticCacheEntries: 0,
      canonicalTruthChanged: false, benefitIsSemanticProof: false, defaultActivation: false,
      workLimitSemantics: 'next-admission-threshold; existing-parent-budget-is-hard-cap' });
  }
  close() { this.#closed = true; this.#families.clear(); this.#grants = new WeakMap(); this.#active = null; }
}
