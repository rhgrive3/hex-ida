import assert from 'node:assert/strict';
import { semanticEvidenceItems, runtimeEvidenceItems } from '../js/semantic-evidence.js';
import { FAMILY, fuse } from '../js/evidence.js';

// #4649: semantic-evidence must verify the raw type of Semantic Fact proof
// metadata before it becomes strength / proof authority. Number() and String()
// coercion laundered schema-external shapes into confidence 1 + FAMILY.VERIFIED.

const proofGrades = ['verified', 'proof', 'proof-grade', 'deterministic'];
const ir = (extraFact, extraEvidence) => [{
  kind: 'write',
  confidence: 0.8,
  evidence: [{ id: 'ev1', row: 1, ...extraEvidence }],
  ...extraFact,
}];

// --- Array confidence must not become strength 1 -------------------------------
assert.deepEqual(semanticEvidenceItems([{
  kind: 'write',
  confidence: ['1'],
  evidence: [{ id: 'ev1', row: 1 }],
}]), [], 'Number(["1"]) === 1 must not mint evidence');

// Numeric-string / boolean / null-ish confidence are not primitive numbers.
for (const confidence of [['1'], '1', true, false, ['0.8'], { toString: () => '1' }]) {
  assert.equal(semanticEvidenceItems([{ kind: 'write', confidence, evidence: [{ id: 'ev1', row: 1 }] }]).length, 0,
    `confidence ${JSON.stringify(confidence)} must not become strength`);
}

// --- Array proofGrade must not become a verified alias ------------------------
for (const grade of proofGrades) {
  const items = semanticEvidenceItems(ir({ proofGrade: [grade] }));
  assert.equal(items.length, 1);
  assert.equal(items[0].code, 'semantic-ir-observation');
  assert.notEqual(items[0].family, FAMILY.VERIFIED, `["${grade}"] must not reach VERIFIED`);
  assert.equal(items[0].strength, 0.8, 'malformed grade must not inflate strength either');
}

// Custom toString() must not forge a grade, and must not run during the decision.
for (const field of ['proofGrade', 'grade']) {
  let calls = 0;
  const forged = { toString() { calls += 1; return 'verified'; } };
  const fromFact = semanticEvidenceItems(ir({ [field]: forged }));
  const fromEvidence = semanticEvidenceItems(ir(null, { [field]: forged }));
  assert.equal(fromFact.length, 1);
  assert.equal(fromEvidence.length, 1);
  assert.equal(fromFact[0].code, 'semantic-ir-observation');
  assert.equal(fromEvidence[0].code, 'semantic-ir-observation');
  assert.equal(calls, 0, `${field}.toString() must not be consulted`);
}

// An Array/Object grade must not be rescued by the fact/evidence alias chain.
assert.equal(semanticEvidenceItems(ir({ proofGrade: ['verified'], grade: ['proof'] }))[0].code, 'semantic-ir-observation');
assert.equal(semanticEvidenceItems(ir({ proofGrade: ['verified'] }, { grade: ['proof'] }))[0].code, 'semantic-ir-observation');

// --- verification origin contract ---------------------------------------------
for (const origin of [[], ['semantic-ir'], true, 1, { toString: () => 'semantic-ir' }]) {
  const items = semanticEvidenceItems(ir({ verificationOrigin: origin }));
  assert.equal(items.length, 1);
  assert.equal(items[0].code, 'semantic-ir-observation',
    `verificationOrigin ${JSON.stringify(origin)} is not a canonical origin`);
  assert.notEqual(items[0].family, FAMILY.VERIFIED);
}

// --- strict verified flag stays strict ---------------------------------------
assert.equal(semanticEvidenceItems(ir({ verified: 'true' }))[0].code, 'semantic-ir-observation');
assert.equal(semanticEvidenceItems(ir({ verified: ['yes'] }))[0].code, 'semantic-ir-observation');
assert.equal(semanticEvidenceItems(ir(null, { verified: true }))[0].code, 'semantic-ir-proof');

// --- no malformed metadata shape reaches FAMILY.VERIFIED ---------------------
for (const fact of [
  { kind: 'write', confidence: ['1'], proofGrade: ['verified'], evidence: [{ id: 'ev1', row: 1 }] },
  { kind: 'write', confidence: 1, proofGrade: ['verified'], verificationOrigin: [], evidence: [{ id: 'ev1', row: 1 }] },
  { kind: 'write', confidence: '0.9', grade: { toString: () => 'proof' }, evidence: [{ id: 'ev1', row: 1 }] },
  { kind: 'write', confidence: true, proofGrade: 'verified', evidence: [{ id: 'ev1', row: 1 }] },
]) {
  assert.equal(semanticEvidenceItems([fact]).filter((x) => x.family === FAMILY.VERIFIED).length, 0,
    'malformed metadata must never produce VERIFIED evidence');
}

// --- primitive numeric confidence keeps its existing clamp -------------------
assert.equal(semanticEvidenceItems(ir({ confidence: 1 })).length, 1);
assert.equal(semanticEvidenceItems(ir({ confidence: 5 }))[0].strength, 1, 'primitive confidence still clamps to 1');
assert.equal(semanticEvidenceItems(ir({ confidence: 0.4 })) [0].strength, 0.4);
for (const confidence of [NaN, Infinity, -Infinity, -1, 0]) {
  assert.equal(semanticEvidenceItems(ir({ confidence })).length, 0, `${confidence} stays non-positive strength`);
}

// --- primitive string proof grade keeps every existing alias -----------------
for (const grade of proofGrades) {
  for (const [field, onEvidence] of [['proofGrade', false], ['proofGrade', true], ['grade', false], ['grade', true]]) {
    const items = semanticEvidenceItems(onEvidence ? ir(null, { [field]: grade }) : ir({ [field]: grade }));
    assert.equal(items.length, 1);
    assert.equal(items[0].code, 'semantic-ir-proof', `alias ${field}=${grade} must stay a proof`);
    assert.equal(items[0].family, FAMILY.VERIFIED);
  }
}
assert.equal(semanticEvidenceItems(ir({ proofGrade: 'Verified' }))[0].code, 'semantic-ir-proof', 'grade stays case-insensitive');
assert.equal(semanticEvidenceItems(ir({ proofGrade: 'verified' }, { proofGrade: 'proof' }))[0].code, 'semantic-ir-proof');
assert.equal(semanticEvidenceItems(ir({ verified: true }))[0].code, 'semantic-ir-proof');
assert.equal(semanticEvidenceItems(ir({ verificationOrigin: 'semantic-ir' }))[0].code, 'semantic-ir-proof');

// --- fusion weighting keeps its denominator ---------------------------------
const genuine = semanticEvidenceItems(ir({ confidence: 1, verified: true }));
const runtime = runtimeEvidenceItems({ ok: true, touchedFields: [{ address: 0x20n }] });
assert.equal(genuine.length, 1);
assert.equal(genuine[0].family, FAMILY.VERIFIED);
assert.equal(genuine[0].lr, 8);
assert.equal(runtime[0].lr, 18);
const fusion = fuse([...genuine, ...runtime]);
assert.ok(fusion.verified >= 1);
assert.equal(fusion.independentGroups, 2, 'dataflow + runtime stay independent origins');
assert.equal(
  fuse([...semanticEvidenceItems(ir({ confidence: ['1'], proofGrade: ['verified'] })), ...runtime]).verified,
  fusion.verified - 1, 'laundered metadata must not add a verified group');

// --- the same strength boundary stays strict for runtime opts ----------------
assert.equal(runtimeEvidenceItems({ ok: true, touchedFields: [{ address: 0x20n }] }, { strength: ['1'] }).length, 0);
assert.equal(runtimeEvidenceItems({ ok: true, touchedFields: [{ address: 0x20n }] }, { strength: '1' }).length, 0);
assert.equal(runtimeEvidenceItems({ ok: true, touchedFields: [{ address: 0x20n }] }, { strength: 0.5 }).length, 1);
assert.equal(runtimeEvidenceItems({ ok: true, touchedFields: [{ address: 0x20n }] }).length, 1);

console.log('issue-4649 semantic proof metadata primitive-type contract: ok');
