/**
 * Scope qualification is a projection of canonical evidence, not an AI fact DB.
 * Candidate data can be serialized. Publication authority stays with the host
 * evidence owner and its support resolver; identifiers and confidence never
 * confer authority.
 */
import { ScopedAnalysisWork, assertScopedAnalysisWork } from '../budgets/scoped-work.js';
import { createEntityId, createEvidenceId, deepFreeze } from '../identity/index.js';
import { assertWorldScope, assertAssumptionSet } from '../identity/world.js';
import {
  snapshotContractData, recordFields, exactString, exactEnum, stringSet, exactInteger,
  assertMatchingId, contractFail,
} from '../identity/structured.js';

export const SCOPED_JUDGMENT_SCHEMA = 'scoped-judgment/v1';
export const SCOPED_QUANTIFIERS = Object.freeze([
  'all-admitted-executions', 'some-witnessed-execution', 'metadata-declaration', 'candidate-only',
]);
export const SCOPED_PRECISIONS = Object.freeze(['exact', 'sound-overapprox', 'sound-underapprox', 'heuristic', 'unknown']);
export const SCOPED_EXECUTION_STATUSES = Object.freeze(['completed', 'budget-exhausted', 'cancelled', 'unsupported', 'failed']);
const QUALIFIED = new WeakSet();
const JUDGMENT_WORLDS = new WeakMap();

function supportRecord(input) {
  const fields = {
    'machine-derived': ['kind', 'producer'], proof: ['kind', 'receipt'],
    metadata: ['kind', 'format', 'record'], observation: ['kind', 'experiment', 'event'],
    'user-assertion': ['kind', 'assertion'], heuristic: ['kind', 'algorithm', 'score'],
  };
  const kind = exactEnum(input?.kind, Object.keys(fields), 'judgment-support-kind');
  recordFields(input, fields[kind], 'judgment-support-fields');
  const out = { kind };
  for (const key of fields[kind]) {
    if (key === 'kind' || key === 'score') continue;
    out[key] = exactString(input[key], `judgment-support-${key}`);
  }
  if (input.score !== undefined) {
    if (typeof input.score !== 'number' || !Number.isFinite(input.score) || input.score < 0 || input.score > 1) contractFail('judgment-support-score');
    out.score = input.score;
  }
  return out;
}

export function createScopedJudgmentCandidate(value, { world, assumptions } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world);
  const input = snapshotContractData(value, { allowBigInt: true });
  recordFields(input, ['subject', 'quantifier', 'value', 'support', 'precision', 'obligations', 'derivation', 'executionStatus'], 'judgment-fields');
  if (!Object.hasOwn(input, 'value')) contractFail('judgment-value-required');
  if (!Array.isArray(input.support) || input.support.length > 4096) contractFail('judgment-support-required');
  return deepFreeze({
    schema: 'scoped-judgment-candidate/v1',
    subject: exactString(input.subject, 'judgment-subject'), world: world.id, assumptions: assumptions.id,
    quantifier: exactEnum(input.quantifier, SCOPED_QUANTIFIERS, 'judgment-quantifier'),
    value: input.value, support: input.support.map(supportRecord),
    precision: exactEnum(input.precision ?? 'unknown', SCOPED_PRECISIONS, 'judgment-precision'),
    obligations: stringSet(input.obligations ?? [], 'judgment-obligations'),
    derivation: exactString(input.derivation, 'judgment-derivation'),
    executionStatus: exactEnum(input.executionStatus ?? 'completed', SCOPED_EXECUTION_STATUSES, 'judgment-execution-status'),
  });
}

function supportIdentity(item) {
  return item.receipt ?? item.producer ?? item.record ?? item.event ?? item.assertion ?? item.algorithm;
}

/**
 * Resolver is an internal host hook, not transported through AnalysisQueryAPI.
 * It must verify both identity and the actual proposition (including value),
 * and return explicit precision/quantifier bounds. A boolean is insufficient.
 */
export async function qualifyScopedJudgment(candidate, {
  world, assumptions, resolveSupport, resolveAssumptions = null,
  scopeObligations = [], signal = null, maxSupports = 4096, work: suppliedWork = null,
} = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world);
  exactInteger(maxSupports, 'judgment-support-budget', { max: 4096 });
  const work = suppliedWork ? assertScopedAnalysisWork(suppliedWork) : new ScopedAnalysisWork({ signal, name: 'judgment-admission' });
  try {
  const input = snapshotContractData(candidate, { allowBigInt: true });
  if (input.schema !== 'scoped-judgment-candidate/v1' || input.world !== world.id || input.assumptions !== assumptions.id) contractFail('judgment-candidate-binding');
  const { schema: _schema, world: _world, assumptions: _assumptions, ...body } = input;
  const checked = createScopedJudgmentCandidate(body, { world, assumptions });
  const unresolved = new Set([...checked.obligations, ...stringSet(scopeObligations, 'judgment-scope-obligations')]);
  if (checked.executionStatus !== 'completed') unresolved.add('execution-not-completed');
  const admitted = [];
  const rejected = [];
  const abort = () => {
    work.checkpoint();
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  };
  abort();
  if (assumptions.satisfiability === 'inconsistent') unresolved.add('inconsistent-assumptions');
  let assumptionsChecked = assumptions.predicates.length === 0;
  if (assumptions.predicates.length && assumptions.satisfiability === 'checked-sat' && typeof resolveAssumptions === 'function') {
    const result = await work.await((providerSignal) => resolveAssumptions(assumptions, { world, signal: providerSignal }));
    abort();
    assumptionsChecked = result?.status === 'checked-sat' && result.world === world.id && result.assumptions === assumptions.id;
  }
  if (!assumptionsChecked) unresolved.add('assumption-satisfiability-unverified');
  for (let i = 0; i < checked.support.length; i++) {
    abort();
    const support = checked.support[i];
    if (i >= maxSupports) { unresolved.add('support-budget-exhausted'); break; }
    let result = null;
    if (typeof resolveSupport === 'function') {
      result = await work.await((providerSignal) => resolveSupport(support, checked, { world, assumptions, signal: providerSignal }));
      abort();
    }
    const bound = result?.world === world.id && result?.assumptions === assumptions.id
      && result?.subject === checked.subject && result?.propositionMatches === true;
    if (!bound || result?.accepted !== true) {
      rejected.push(supportIdentity(support));
      unresolved.add('support-not-admitted');
      continue;
    }
    // Observations are existential, metadata is declarative, user statements
    // and similarity/LLM scores remain hypotheses even when recorded by a host.
    const quantifier = support.kind === 'observation' ? 'some-witnessed-execution'
      : support.kind === 'metadata' ? 'metadata-declaration'
        : ['user-assertion', 'heuristic'].includes(support.kind) ? 'candidate-only' : result.quantifier;
    const precision = exactEnum(result.precision, SCOPED_PRECISIONS, 'judgment-resolver-precision');
    if (support.kind === 'proof' && !['derivation-checked', 'solver-validated', 'independent-proof-checked'].includes(result.checkerLevel)) {
      unresolved.add('proof-checker-level-insufficient'); rejected.push(supportIdentity(support)); continue;
    }
    admitted.push({ id: supportIdentity(support), kind: support.kind, precision, quantifier });
  }
  const theoremSupports = admitted.filter((s) => ['machine-derived', 'proof'].includes(s.kind)
    && s.quantifier === checked.quantifier);
  const matching = admitted.filter((s) => s.quantifier === checked.quantifier);
  let precision = checked.precision;
  let quantifier = checked.quantifier;
  if (precision === 'exact') {
    const support = quantifier === 'all-admitted-executions' ? theoremSupports : matching;
    if (!support.some((s) => s.precision === 'exact') || unresolved.size) precision = 'unknown';
  } else if (precision === 'sound-overapprox') {
    if (quantifier !== 'all-admitted-executions' || !theoremSupports.some((s) => ['exact', 'sound-overapprox'].includes(s.precision)) || unresolved.size) precision = 'unknown';
  } else if (precision === 'sound-underapprox') {
    if (quantifier !== 'some-witnessed-execution' || !matching.some((s) => ['exact', 'sound-underapprox'].includes(s.precision)) || unresolved.size) precision = 'unknown';
  }
  if (quantifier === 'candidate-only' && precision !== 'unknown') precision = 'heuristic';
  if (assumptions.satisfiability === 'inconsistent') { precision = 'unknown'; quantifier = 'candidate-only'; }
  if (precision === 'unknown' && checked.precision !== 'unknown') unresolved.add('requested-precision-not-established');
  const resultBody = {
    schema: SCOPED_JUDGMENT_SCHEMA, subject: checked.subject, world: world.id, assumptions: assumptions.id,
    quantifier, value: checked.value, support: checked.support, precision,
    requestedPrecision: checked.precision, obligations: [...unresolved].sort(),
    derivation: checked.derivation, executionStatus: checked.executionStatus,
    admission: { admitted, rejected, assumptionsChecked },
  };
  const id = createEntityId({ binaryId: world.binarySet[0].binaryId, kind: SCOPED_JUDGMENT_SCHEMA, identity: resultBody });
  abort();
  const result = deepFreeze({ ...resultBody, id });
  QUALIFIED.add(result);
  JUDGMENT_WORLDS.set(result, world);
  return result;
  } finally { if (!suppliedWork) work.dispose(); }
}

export function assertQualifiedJudgment(value) {
  if (!value || !QUALIFIED.has(value)) contractFail('judgment-not-host-qualified');
  return value;
}

/** An imported JSON judgment is data until replay has qualified it again. */
export function inspectSerializedJudgment(value, { world } = {}) {
  assertWorldScope(world);
  const input = snapshotContractData(value, { allowBigInt: true });
  if (input.schema !== SCOPED_JUDGMENT_SCHEMA || input.world !== world.id) contractFail('judgment-import-binding');
  const { id, ...body } = input;
  const expected = createEntityId({ binaryId: world.binarySet[0].binaryId, kind: SCOPED_JUDGMENT_SCHEMA, identity: body });
  exactString(id, 'judgment-import-id-required');
  assertMatchingId(id, expected, 'judgment-import-id');
  return deepFreeze({ candidate: input, admitted: false, precision: 'unknown', reason: 'import-requires-requalification' });
}

export function scopedJudgmentClaim(judgment, { binaryId, origin = {} } = {}) {
  assertQualifiedJudgment(judgment);
  const world = JUDGMENT_WORLDS.get(judgment);
  if (!world?.binarySet.some((entry) => entry.binaryId === binaryId)) contractFail('judgment-claim-binary-mismatch');
  const supportIds = stringSet(judgment.admission.admitted.map((s) => s.id));
  return {
    id: createEvidenceId({ binaryId, kind: SCOPED_JUDGMENT_SCHEMA, identity: { judgmentId: judgment.id } }),
    family: 'Claim', binaryId, targetEntityIds: [judgment.subject],
    semanticKind: SCOPED_JUDGMENT_SCHEMA,
    scope: { world: judgment.world, assumptions: judgment.assumptions, quantifier: judgment.quantifier },
    supportingEvidenceIds: supportIds, confirmedByEvidenceIds: [], contradictingEvidenceIds: [],
    assumptions: [], verdict: supportIds.length ? 'supported' : 'unknown',
    completeness: judgment.obligations.length ? 'partial' : 'bounded', origin,
    payload: { scopedJudgment: judgment },
  };
}
