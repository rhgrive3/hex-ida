import assert from 'node:assert/strict';
import { semanticEvidenceItems, runtimeEvidenceItems } from '../js/semantic-evidence.js';
import { FAMILY } from '../js/evidence.js';

// #4110: a structured proof grade must not launder into an explicit semantic
// proof via String() coercion — String(['verified']) === 'verified' promoted
// schema-external grades to FAMILY.VERIFIED at the evidence-fusion boundary.

const fact = (extra) => [{
  kind: 'threshold-comparison',
  confidence: 1,
  ...extra,
  evidence: [{ id: 'ir:1', instructionId: '1' }],
}];

// Array / object / number / boolean grades stay observations, never proofs.
for (const badGrade of [['verified'], ['proof'], ['deterministic'], ['proof-grade'], 1, 0, true]) {
  const [item] = semanticEvidenceItems(fact({ proofGrade: badGrade }));
  assert.equal(item.kind, 'semantic', `array/number/bool proofGrade ${JSON.stringify(badGrade)} must not verify`);
  assert.equal(item.family, FAMILY.USAGE);
}
for (const badGrade of [['verified'], ['proof'], 1, true]) {
  const [item] = semanticEvidenceItems(fact({ grade: badGrade }));
  assert.equal(item.kind, 'semantic');
  assert.equal(item.family, FAMILY.USAGE);
}

// A custom toString() must not run while deciding proof authority.
let toStringCalls = 0;
const [coerced] = semanticEvidenceItems(fact({
  proofGrade: { toString() { toStringCalls += 1; return 'verified'; } },
}));
assert.equal(coerced.kind, 'semantic');
assert.equal(toStringCalls, 0);

// Primitive string grades keep promoting to verified proof.
for (const goodGrade of ['verified', 'proof', 'proof-grade', 'deterministic']) {
  const [item] = semanticEvidenceItems(fact({ proofGrade: goodGrade }));
  assert.equal(item.kind, 'verified', `string grade ${goodGrade} must verify`);
  assert.equal(item.family, FAMILY.VERIFIED);
}

// Explicit boolean verification / verification origin paths are unchanged.
const [byFlag] = semanticEvidenceItems(fact({ verified: true }));
assert.equal(byFlag.kind, 'verified');
const [byOrigin] = semanticEvidenceItems(fact({ verificationOrigin: 'sandbox' }));
assert.equal(byOrigin.kind, 'verified');
const [plain] = semanticEvidenceItems(fact({}));
assert.equal(plain.kind, 'semantic');

// Runtime structured status must not launder into a completion alias (#4110 / #5367).
assert.equal(runtimeEvidenceItems({
  status: ['complete'],
  touchedFields: [{ key: 'field:hp' }],
}).length, 0);
const [runtimeOk] = runtimeEvidenceItems({
  status: 'complete',
  touchedFields: [{ key: 'field:hp' }],
});
assert.equal(runtimeOk.kind, 'verified');
assert.equal(runtimeOk.code, 'runtime-field-verified');

console.log('issue-4110 semantic proof grade primitive-string contract: ok');
