/** Lower/upper set bounds. Candidates never become feasible members by ranking. */
import { createEntityId, deepFreeze, stableStringify, lossyTypeWitness } from '../identity/index.js';
import { assertQualifiedJudgment } from './scoped.js';
import { assertWorldScope, assertAssumptionSet } from '../identity/world.js';
import { snapshotContractData, recordFields, exactString, exactEnum, stringSet, compareIdentity, contractFail } from '../identity/structured.js';

export const SET_ENVELOPE_SCHEMA = 'set-envelope/v1';
const ENVELOPES = new WeakSet();
const ADMISSIONS = new WeakMap();
const sameValue = (a, b) => stableStringify(a) === stableStringify(b) && stableStringify(lossyTypeWitness(a)) === stableStringify(lossyTypeWitness(b));

function members(input, code, cap) {
  if (!Array.isArray(input) || input.length > cap) contractFail(code);
  const out = new Map();
  for (const item of input) {
    recordFields(item, ['id', 'value', 'evidenceIds'], `${code}-fields`);
    const id = exactString(item.id, `${code}-id`);
    const normalized = { id, value: item.value ?? null, evidenceIds: stringSet(item.evidenceIds ?? [], `${code}-evidence`) };
    if (out.has(id) && !sameValue(out.get(id).value, normalized.value)) contractFail(`${code}-identity-conflict`);
    if (out.has(id)) normalized.evidenceIds = stringSet([...out.get(id).evidenceIds, ...normalized.evidenceIds]);
    out.set(id, normalized);
  }
  return [...out.values()].sort((a, b) => compareIdentity(a.id, b.id));
}

/**
 * Host producers supply admitted lower/upper witnesses. This constructor only
 * preserves/checks that contract; its returned object is NOT a proof receipt.
 */
export function createSetEnvelope(value, { world, maxMembers = 8192 } = {}) {
  assertWorldScope(world);
  if (!Number.isSafeInteger(maxMembers) || maxMembers < 0 || maxMembers > 65536) contractFail('set-member-budget');
  const input = snapshotContractData(value, { allowBigInt: true });
  recordFields(input, ['domain', 'provenMembers', 'upper', 'rankedCandidates', 'closure'], 'set-envelope-fields');
  const domain = exactString(input.domain, 'set-domain');
  const lower = members(input.provenMembers ?? [], 'set-lower', maxMembers);
  if (lower.some((item) => !item.evidenceIds.length)) contractFail('set-lower-witness-required');
  recordFields(input.upper, ['kind', 'members', 'domain', 'evidenceIds'], 'set-upper-fields');
  const upperKind = exactEnum(input.upper.kind, ['top', 'finite'], 'set-upper-kind');
  let upper;
  if (upperKind === 'top') {
    if (input.upper.members !== undefined || (input.upper.domain !== undefined && input.upper.domain !== domain)) contractFail('set-top-domain');
    upper = { kind: 'top', domain };
  } else {
    const evidenceIds = stringSet(input.upper.evidenceIds ?? [], 'set-upper-evidence');
    if (!evidenceIds.length) contractFail('set-finite-upper-witness-required');
    upper = { kind: 'finite', members: members(input.upper.members, 'set-upper-members', maxMembers), evidenceIds };
  }
  const candidateInput = input.rankedCandidates ?? [];
  if (!Array.isArray(candidateInput) || candidateInput.length > maxMembers) contractFail('set-candidate-budget');
  const rankedCandidates = candidateInput.map((candidate) => {
    recordFields(candidate, ['item', 'source', 'score'], 'set-candidate-fields');
    const item = members([candidate.item], 'set-candidate-item', 1)[0];
    const out = { item, source: exactString(candidate.source, 'set-candidate-source') };
    if (candidate.score !== undefined) {
      if (typeof candidate.score !== 'number' || !Number.isFinite(candidate.score) || candidate.score < 0 || candidate.score > 1) contractFail('set-candidate-score');
      out.score = candidate.score;
    }
    return out;
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || compareIdentity(a.item.id, b.item.id) || compareIdentity(a.source, b.source));
  // One member ID denotes one typed value throughout the envelope, including
  // merely ranked candidates. Matching IDs alone must not make unlike bounds
  // (for example 1n and '1') appear exact.
  const valuesById = new Map();
  for (const item of [...lower, ...(upperKind === 'finite' ? upper.members : []), ...rankedCandidates.map((candidate) => candidate.item)]) {
    if (valuesById.has(item.id) && !sameValue(valuesById.get(item.id), item.value)) contractFail('set-member-identity-conflict');
    valuesById.set(item.id, item.value);
  }
  recordFields(input.closure, ['status', 'certificate', 'frontier'], 'set-closure-fields');
  const closure = {
    status: exactEnum(input.closure.status, ['closed', 'open', 'unsupported'], 'set-closure-status'),
    certificate: input.closure.certificate == null ? null : exactString(input.closure.certificate, 'set-closure-certificate'),
    frontier: stringSet(input.closure.frontier ?? [], 'set-closure-frontier'),
  };
  if (closure.status === 'closed' && (!closure.certificate || closure.frontier.length || upperKind !== 'finite')) contractFail('set-closure-unproven');
  const upperIds = upperKind === 'finite' ? new Set(upper.members.map((item) => item.id)) : null;
  const conflicts = upperIds ? lower.filter((item) => !upperIds.has(item.id)).map((item) => item.id) : [];
  const exactCandidate = conflicts.length === 0 && closure.status === 'closed' && upperKind === 'finite'
    && lower.length === upper.members.length && lower.every((item, i) => item.id === upper.members[i].id);
  const body = { schema: SET_ENVELOPE_SCHEMA, world: world.id, domain, provenMembers: lower, upper, rankedCandidates, closure, exact: false, exactCandidate, conflicts };
  const id = createEntityId({ binaryId: world.binarySet[0].binaryId, kind: SET_ENVELOPE_SCHEMA, identity: body });
  const result = deepFreeze({ ...body, id });
  ENVELOPES.add(result);
  return result;
}

export function assertSetEnvelope(value, world) {
  assertWorldScope(world);
  if (!ENVELOPES.has(value) || value.world !== world.id) contractFail('set-envelope-noncanonical-or-world-mismatch');
  return value;
}

/** Construct a same-domain bound conjunction candidate. Requalification is mandatory. */
export function refineSetEnvelope(previous, additional, { world, closure = null, maxMembers = 8192 } = {}) {
  assertSetEnvelope(previous, world); assertSetEnvelope(additional, world);
  // A qualified view refers to the candidate's proposition; composing that
  // view would silently discard its admission boundary and mix identities.
  // Callers must explicitly choose and requalify the original candidates.
  if (ADMISSIONS.has(previous) || ADMISSIONS.has(additional)) contractFail('set-refinement-requires-candidates');
  if (previous.domain !== additional.domain) contractFail('set-envelope-domain-mismatch');
  let upper;
  if (previous.upper.kind === 'top') upper = additional.upper;
  else if (additional.upper.kind === 'top') upper = previous.upper;
  else {
    const right = new Map(additional.upper.members.map((item) => [item.id, item]));
    upper = {
      kind: 'finite', members: previous.upper.members.filter((item) => right.has(item.id)).map((item) => {
        if (!sameValue(item.value, right.get(item.id).value)) contractFail('set-refinement-identity-conflict');
        return { ...item, evidenceIds: stringSet([...item.evidenceIds, ...right.get(item.id).evidenceIds]) };
      }), evidenceIds: stringSet([...previous.upper.evidenceIds, ...additional.upper.evidenceIds]),
    };
  }
  const lower = members([...previous.provenMembers, ...additional.provenMembers], 'set-refined-lower', maxMembers * 2);
  if (lower.length > maxMembers) contractFail('set-refinement-lower-budget');
  const candidateMap = new Map();
  for (const candidate of [...previous.rankedCandidates, ...additional.rankedCandidates]) {
    const key = `${candidate.item.id.length}:${candidate.item.id}${candidate.source}`;
    const old = candidateMap.get(key);
    if (old && !sameValue(old.item.value, candidate.item.value)) contractFail('set-refinement-identity-conflict');
    if (!old || (candidate.score ?? -1) > (old.score ?? -1)) candidateMap.set(key, candidate);
  }
  // A prior closure receipt need not certify the new intersection. Reopen unless
  // a checker supplied a certificate for this exact composed bound.
  const combinedClosure = closure ?? {
    status: 'open', certificate: null,
    frontier: stringSet([...previous.closure.frontier, ...additional.closure.frontier, 'composed-bound-closure-unverified']),
  };
  return createSetEnvelope({ domain: previous.domain, provenMembers: lower, upper,
    rankedCandidates: [...candidateMap.values()].slice(0, maxMembers), closure: combinedClosure }, { world, maxMembers });
}

/** Proposition identity is tied to all candidate bounds and their typed values. */
export function setBoundProposition(envelope, kind, memberId = null) {
  if (!ENVELOPES.has(envelope) || ADMISSIONS.has(envelope)) contractFail('set-bound-requires-candidate-envelope');
  exactEnum(kind, ['sound-upper-bound', 'feasible-member', 'closed-world'], 'set-bound-proposition-kind');
  if (kind === 'feasible-member') exactString(memberId, 'set-bound-member');
  else if (memberId !== null) contractFail('set-bound-unexpected-member');
  return deepFreeze({ kind, envelopeId: envelope.id, ...(memberId === null ? {} : { memberId }) });
}

/**
 * Only qualified canonical judgments admit a bound. A certificate ID, a caller
 * boolean, or a deserialized `exact: true` never does. Returned shape is a VIEW;
 * process-local admission is discarded by serialization and requires replay.
 */
export function qualifySetEnvelope(envelope, { world, assumptions, upperJudgment = null, memberJudgments = [], closureJudgment = null } = {}) {
  assertSetEnvelope(envelope, world); assertAssumptionSet(assumptions, world);
  if (ADMISSIONS.has(envelope)) contractFail('set-bound-already-qualified');
  if (!Array.isArray(memberJudgments) || memberJudgments.length > 65536) contractFail('set-member-proof-budget');
  const verify = (judgment, kind, memberId, quantifier, precisions) => {
    if (judgment === null) return false;
    assertQualifiedJudgment(judgment);
    return judgment.world === world.id && judgment.assumptions === assumptions.id && judgment.subject === envelope.id
      && judgment.quantifier === quantifier && precisions.includes(judgment.precision)
      && judgment.obligations.length === 0 && judgment.executionStatus === 'completed'
      && sameValue(judgment.value, setBoundProposition(envelope, kind, memberId));
  };
  const upperAdmitted = envelope.upper.kind === 'top' || verify(upperJudgment, 'sound-upper-bound', null, 'all-admitted-executions', ['exact', 'sound-overapprox']);
  const admittedMembers = new Set();
  const lowerIds = new Set(envelope.provenMembers.map((item) => item.id));
  for (const judgment of memberJudgments) {
    assertQualifiedJudgment(judgment);
    const memberId = judgment.value?.memberId;
    if (lowerIds.has(memberId) && verify(judgment, 'feasible-member', memberId, 'some-witnessed-execution', ['exact', 'sound-underapprox'])) admittedMembers.add(memberId);
  }
  const closureAdmitted = envelope.closure.status === 'closed'
    && verify(closureJudgment, 'closed-world', null, 'all-admitted-executions', ['exact']);
  const conflicts = upperAdmitted && envelope.upper.kind === 'finite'
    ? [...admittedMembers].filter((id) => !envelope.upper.members.some((member) => member.id === id)) : [];
  const exact = upperAdmitted && closureAdmitted && conflicts.length === 0 && envelope.upper.kind === 'finite'
    && envelope.upper.members.length === admittedMembers.size && envelope.upper.members.every((item) => admittedMembers.has(item.id));
  const viewBody = { ...envelope, schema: 'qualified-set-envelope-view/v1', candidateEnvelopeId: envelope.id, exact, admission: {
    schema: 'set-admission/v1', assumptions: assumptions.id, upperAdmitted, closureAdmitted,
    memberIds: [...admittedMembers].sort(compareIdentity), conflicts,
    judgmentIds: stringSet([upperJudgment, ...memberJudgments, closureJudgment].filter(Boolean).map((j) => j.id)),
  } };
  delete viewBody.id;
  const id = createEntityId({ binaryId: world.binarySet[0].binaryId, kind: viewBody.schema, identity: viewBody });
  const result = deepFreeze({ ...viewBody, id });
  ENVELOPES.add(result);
  ADMISSIONS.set(result, result.admission);
  return result;
}

export function setExistenceVerdict(envelope) {
  if (!ENVELOPES.has(envelope)) contractFail('set-envelope-noncanonical');
  const admitted = ADMISSIONS.get(envelope);
  if (admitted?.conflicts.length) return 'INCONSISTENT';
  if (admitted?.memberIds.length) return 'PROVEN_EXISTS';
  if (admitted?.upperAdmitted && admitted.closureAdmitted && envelope.upper.kind === 'finite' && envelope.upper.members.length === 0) return 'PROVEN_NONE';
  if (envelope.provenMembers.length || envelope.rankedCandidates.length || (envelope.upper.kind === 'finite' && envelope.upper.members.length)) return 'POSSIBLE';
  return 'UNKNOWN';
}
