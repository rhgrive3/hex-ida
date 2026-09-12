import test from 'node:test';
import assert from 'node:assert/strict';
import { createScopedJudgmentCandidate, qualifyScopedJudgment, assertQualifiedJudgment, inspectSerializedJudgment, scopedJudgmentClaim } from '../../js/core/evidence/scoped.js';
import { createSetEnvelope, refineSetEnvelope, qualifySetEnvelope, setBoundProposition, setExistenceVerdict } from '../../js/core/evidence/set-envelope.js';
import { createAssumptionSet } from '../../js/core/identity/world.js';
import { fixture, candidateInput, qualified, supportResolver, envelopeInput, member, workFor } from './helpers.mjs';

test('host-bound machine evidence admits exact only in matching world and proposition', async () => {
  const f = fixture(); const j = await qualified(f); assert.equal(j.precision, 'exact'); assertQualifiedJudgment(j);
  assert.throws(() => assertQualifiedJudgment(JSON.parse(JSON.stringify(j))), /not-host-qualified/);
  assert.equal(inspectSerializedJudgment(j, f).admitted, false); assert.throws(() => inspectSerializedJudgment({ ...j, value: 100 }, f), /import-id/);
  assert.equal(scopedJudgmentClaim(j, { binaryId: f.world.binarySet[0].binaryId }).verdict, 'supported');
  assert.throws(() => scopedJudgmentClaim(j, { binaryId: 'foreign' }), /binary-mismatch/);
});
for (const bad of [{ accepted: false }, { world: 'foreign' }, { assumptions: 'foreign' }, { subject: 'foreign' }, { propositionMatches: false }]) test(`mismatched support demotes exact: ${Object.keys(bad)[0]}`, async () => {
  const f = fixture(); const j = await qualified(f, {}, { resolveSupport: supportResolver(f.world, f.assumptions, bad) }); assert.equal(j.precision, 'unknown'); assert.ok(j.obligations.includes('support-not-admitted'));
});
for (const support of [{ kind: 'observation', experiment: 'exp', event: 'event' }, { kind: 'metadata', format: 'elf', record: 'record' }, { kind: 'heuristic', algorithm: 'similarity', score: 1 }, { kind: 'user-assertion', assertion: 'user' }]) test(`${support.kind} never proves a universal theorem`, async () => {
  const j = await qualified(fixture(), { support: [support] }); assert.equal(j.precision, 'unknown');
});
test('observations can establish existential lower bounds, not a closed upper bound', async () => {
  const j = await qualified(fixture(), { quantifier: 'some-witnessed-execution', precision: 'sound-underapprox', support: [{ kind: 'observation', experiment: 'exp', event: 'event' }] }); assert.equal(j.precision, 'sound-underapprox');
});
for (const executionStatus of ['budget-exhausted', 'cancelled', 'unsupported', 'failed']) test(`incomplete ${executionStatus} cannot retain exact`, async () => {
  const j = await qualified(fixture(), { executionStatus }); assert.equal(j.precision, 'unknown'); assert.ok(j.obligations.includes('execution-not-completed'));
});
test('missing checker, open obligations and support truncation cannot retain exact', async () => {
  const f = fixture();
  assert.equal((await qualified(f, { support: [{ kind: 'proof', receipt: 'receipt' }] }, { resolveSupport: supportResolver(f.world, f.assumptions, { checkerLevel: 'source-binding-checked' }) })).precision, 'unknown');
  assert.equal((await qualified(f, { obligations: ['unread-callee'] })).precision, 'unknown');
  assert.equal((await qualified(f, {}, { maxSupports: 0 })).precision, 'unknown');
});
test('SAT text and evidence IDs do not bypass actual assumption admission', async () => {
  const f = fixture(); f.assumptions = createAssumptionSet({ predicates: ['x>0'], satisfiability: 'checked-sat', satisfiabilityEvidence: ['receipt'] }, f.world);
  assert.equal((await qualified(f)).precision, 'unknown');
  assert.equal((await qualified(f, {}, { resolveAssumptions: () => ({ status: 'checked-sat', world: f.world.id, assumptions: f.assumptions.id }) })).precision, 'exact');
});
test('inconsistent assumptions cannot yield a vacuous exact theorem', async () => {
  const f = fixture(); f.assumptions = createAssumptionSet({ predicates: ['x', 'not-x'], satisfiability: 'inconsistent', satisfiabilityEvidence: ['counterexample'] }, f.world);
  const j = await qualified(f); assert.equal(j.precision, 'unknown'); assert.equal(j.quantifier, 'candidate-only');
});
test('disposed supplied work cannot publish even a supportless judgment', async t => {
  const f = fixture(), work = workFor(t); work.dispose();
  const c = createScopedJudgmentCandidate(candidateInput({ support: [], precision: 'unknown' }), f);
  await assert.rejects(qualifyScopedJudgment(c, { ...f, work }), e => e.status === 'cancelled');
});
test('candidate finite empty set is UNKNOWN, never proof of absence', () => {
  const f = fixture(), e = createSetEnvelope(envelopeInput(), f); assert.equal(e.exact, false); assert.equal(e.exactCandidate, true); assert.equal(setExistenceVerdict(e), 'UNKNOWN');
});
test('ranked candidate with confidence one is only POSSIBLE', () => {
  const f = fixture(), e = createSetEnvelope({ ...envelopeInput(), upper: { kind: 'top' }, closure: { status: 'open', frontier: ['unread'] }, rankedCandidates: [{ item: member(), source: 'heuristic', score: 1 }] }, f);
  assert.equal(setExistenceVerdict(e), 'POSSIBLE'); assert.equal(e.exact, false);
});
async function boundProof(f, e, kind, id = null) { return qualified(f, { subject: e.id, value: setBoundProposition(e, kind, id), quantifier: kind === 'feasible-member' ? 'some-witnessed-execution' : 'all-admitted-executions' }); }
test('empty finite upper requires independent admitted closure and upper judgments', async () => {
  const f = fixture(), e = createSetEnvelope(envelopeInput(), f);
  const upperJudgment = await boundProof(f, e, 'sound-upper-bound'), closureJudgment = await boundProof(f, e, 'closed-world');
  assert.equal(setExistenceVerdict(qualifySetEnvelope(e, { ...f, upperJudgment })), 'UNKNOWN');
  const q = qualifySetEnvelope(e, { ...f, upperJudgment, closureJudgment }); assert.equal(setExistenceVerdict(q), 'PROVEN_NONE'); assert.ok(q.exact);
  assert.throws(() => setExistenceVerdict(JSON.parse(JSON.stringify(q))), /noncanonical/);
});
test('finite exact set requires every member proof and a common scope', async () => {
  const f = fixture(), e = createSetEnvelope(envelopeInput([member()]), f);
  const upperJudgment = await boundProof(f, e, 'sound-upper-bound'), closureJudgment = await boundProof(f, e, 'closed-world'), memberJudgments = [await boundProof(f, e, 'feasible-member', 'target-a')];
  assert.equal(qualifySetEnvelope(e, { ...f, upperJudgment, closureJudgment }).exact, false);
  const q = qualifySetEnvelope(e, { ...f, upperJudgment, closureJudgment, memberJudgments }); assert.ok(q.exact); assert.equal(setExistenceVerdict(q), 'PROVEN_EXISTS');
  assert.throws(() => refineSetEnvelope(q, e, f), /requires-candidates/);
});
test('same member ID with conflicting typed lower/upper values fails closed', () => {
  const f = fixture(), d = envelopeInput([member('a', 1n)]); d.upper.members = [member('a', '1')]; assert.throws(() => createSetEnvelope(d, f), /identity-conflict/);
});
test('set refinement reopens closure, intersects upper and unions lower', () => {
  const f = fixture(), a = createSetEnvelope({ ...envelopeInput([member('a')]), upper: { kind: 'finite', members: [member('a'), member('b')], evidenceIds: ['up-a'] } }, f), b = createSetEnvelope(envelopeInput([member('b')]), f);
  const r = refineSetEnvelope(a, b, f); assert.equal(r.closure.status, 'open'); assert.deepEqual(r.upper.members.map(m => m.id), ['b']); assert.deepEqual(r.provenMembers.map(m => m.id), ['a', 'b']); assert.equal(r.exact, false);
});
test('set construction rejects closed TOP, absent lower witnesses and duplicate conflicting values', () => {
  const f = fixture(); assert.throws(() => createSetEnvelope({ ...envelopeInput(), upper: { kind: 'top' } }, f), /closure-unproven/);
  assert.throws(() => createSetEnvelope(envelopeInput([{ ...member(), evidenceIds: [] }]), f), /witness-required/);
  assert.throws(() => createSetEnvelope(envelopeInput([member('a', 1), member('a', 2)]), f), /identity-conflict/);
});
