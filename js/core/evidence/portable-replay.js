import { PORTABLE_LOOP_SCHEMA, replayPortableLoop } from './portable-loop.js';
/** Minimal detached replay surface. It reuses the existing small A64 checker,
 * never imports a native provider, solver, decoder or decompiler. The capsule
 * cannot select code, URLs, callbacks, checker versions, or semantic authority.
 * Current-source membership must be re-established by the live native service.
 */
import { snapshotContractData, recordFields, exactString, contractFail } from '../identity/structured.js';
import { deepFreeze, stableStringify } from '../identity/index.js';
import { assertScopedAnalysisWork } from '../budgets/scoped-work.js';
import { checkIntegerFragmentBytes, INTEGER_FRAGMENT_SCHEMA, INTEGER_FRAGMENT_RULE, INTEGER_FRAGMENT_RULE_VERSION, INTEGER_FRAGMENT_CHECKER_VERSION, supportsIntegerFragmentProfile,
  INTEGER_FRAGMENT_DOMAIN, INTEGER_FRAGMENT_MAX_INSTRUCTIONS } from './arm64-integer-fragment.js';

export const PORTABLE_CHECK_SCHEMA = 'scpa-portable-integer-checks/v1';
export const PORTABLE_CHECK_LIMITS = Object.freeze({ checks: 16, encodedBytes: 262144, sourceBytes: 4096, nodes: 8192 });
const decimal = s => {
  if (typeof s !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(s) || BigInt(s) >= (1n << 64n)) contractFail('portable-source-address');
  return BigInt(s);
};
export function normalizePortableChecks(input) {
  const capsule = snapshotContractData(input, { maxBytes: PORTABLE_CHECK_LIMITS.encodedBytes, maxNodes: PORTABLE_CHECK_LIMITS.nodes });
  recordFields(capsule, ['schema', 'binding', 'checks', 'remaining'], 'portable-capsule-fields');
  if (capsule.schema !== PORTABLE_CHECK_SCHEMA || !Array.isArray(capsule.checks) || capsule.checks.length > PORTABLE_CHECK_LIMITS.checks
    || !Array.isArray(capsule.remaining) || capsule.remaining.length > 128) contractFail('portable-capsule-schema-or-budget');
  const b = capsule.binding;
  recordFields(b, ['worldId', 'assumptionsId', 'snapshotId', 'binaryId', 'functionId', 'functionLocator', 'producerArtifactId'], 'portable-binding-fields');
  for (const key of Object.keys(b)) exactString(b[key], 'portable-binding-string', 512);
  for (const key of ['worldId', 'assumptionsId', 'snapshotId', 'binaryId', 'functionId', 'functionLocator', 'producerArtifactId']) exactString(b[key], 'portable-binding-required', 512);
  capsule.remaining.forEach(v => exactString(v, 'portable-remaining', 512));
  const ids = new Set(); let bytes = 0;
  for (const check of capsule.checks) {
    recordFields(check, ['id', 'fragment', 'bytesHex'], 'portable-check-fields'); exactString(check.id, 'portable-check-id', 512);
    if (ids.has(check.id)) contractFail('portable-duplicate-check'); ids.add(check.id);
    const f = check.fragment;
    recordFields(f, ['schema', 'ruleId', 'ruleVersion', 'worldId', 'assumptionsId', 'snapshotId', 'functionId', 'profile', 'domain',
      'source', 'rangeLocalId', 'semanticValueId', 'conclusion'], 'portable-fragment-fields');
    if (f.schema !== INTEGER_FRAGMENT_SCHEMA || f.worldId !== b.worldId || f.assumptionsId !== b.assumptionsId
      || f.snapshotId !== b.snapshotId || f.functionId !== b.functionId || f.source?.binaryId !== b.binaryId) contractFail('portable-fragment-binding');
    recordFields(f.source, ['binaryId', 'start', 'end', 'boundary', 'virtualStart', 'virtualBoundary'], 'portable-source-fields');
    const start = decimal(f.source.start), boundary = decimal(f.source.boundary), end = decimal(f.source.end);
    const va = decimal(f.source.virtualStart), vb = decimal(f.source.virtualBoundary);
    if (end !== boundary + 4n || boundary <= start || boundary - start > BigInt(INTEGER_FRAGMENT_MAX_INSTRUCTIONS * 4)
      || (boundary - start) % 4n || va % 4n || vb - va !== boundary - start) contractFail('portable-fragment-source-range');
    if (typeof check.bytesHex !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(check.bytesHex)
      || check.bytesHex.length !== Number(boundary - start) * 2) contractFail('portable-fragment-bytes');
    bytes += check.bytesHex.length / 2;
    if (bytes > PORTABLE_CHECK_LIMITS.sourceBytes) contractFail('portable-total-byte-budget');
  }
  return deepFreeze(capsule);
}
export async function replayPortableChecks(input, { work } = {}) {
  assertScopedAnalysisWork(work); work.checkpoint();
  const data = snapshotContractData(input, { maxBytes: PORTABLE_CHECK_LIMITS.encodedBytes, maxNodes: PORTABLE_CHECK_LIMITS.nodes });
  if (data.schema === PORTABLE_LOOP_SCHEMA) return replayPortableLoop(data, { work });
  const capsule = normalizePortableChecks(data); work.charge('residentBytes', stableStringify(capsule).length * 2);
  const checks = [];
  for (const item of capsule.checks) {
    const f = item.fragment; work.charge('workUnits');
    let result;
    if (f.ruleId !== INTEGER_FRAGMENT_RULE || f.ruleVersion !== INTEGER_FRAGMENT_RULE_VERSION) result = { status: 'unknown', reason: 'portable-checker-version-unavailable' };
    else if (stableStringify(f.domain) !== stableStringify(INTEGER_FRAGMENT_DOMAIN) || !supportsIntegerFragmentProfile(f.profile)) result = { status: 'unknown', reason: 'portable-profile-or-domain-unsupported' };
    else {
      const bytes = Uint8Array.from(item.bytesHex.match(/../g), s => parseInt(s, 16));
      result = checkIntegerFragmentBytes(bytes, f.conclusion, { work });
    }
    checks.push({ id: item.id, ...result }); await work.yieldIfNeeded();
  }
  const rejected = checks.filter(v => v.status === 'rejected').length, verified = checks.filter(v => v.status === 'verified').length;
  work.checkpoint();
  return deepFreeze({ schema: 'scpa-portable-replay-result/v1', status: 'completed', checkerVersion: INTEGER_FRAGMENT_CHECKER_VERSION,
    binding: capsule.binding, checks, counts: { requested: checks.length, verified, rejected, unknown: checks.length - verified - rejected },
    // Empty lists are explicitly unproved, not all([]) == true.
    allListedDerivationsChecked: checks.length > 0 && verified === checks.length,
    sourceBinding: 'detached-unverified', exact: false, semanticProof: false, wholeQueryProof: false,
    executableCodeAccepted: false, remaining: [...capsule.remaining, 'current-source-and-owner-rebinding-required',
      'root-query-and-reachability-not-proved', 'independent-rule-implementation-qualification-open'] });
}
