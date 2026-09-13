import assert from 'node:assert/strict';
import { semanticEvidenceItems } from '../js/semantic-evidence.js';
import { FAMILY } from '../js/evidence.js';

const spoofed = semanticEvidenceItems([{
  kind: 'write',
  confidence: ['1'],
  proofGrade: ['verified'],
  evidence: [{ id: 'ev1', row: 1 }],
}]);
assert.equal(spoofed.length, 0, 'structured confidence must not promote an item at all');

for (const confidence of [['1'], '0.5', true, {}, ['x']]) {
  const items = semanticEvidenceItems([{ kind: 'write', confidence, evidence: [{ id: 'a', row: 2 }] }]);
  assert.equal(items.length, 0, 'non-primitive confidence must yield no evidence');
}

let valueOfCalls = 0;
const coercing = {
  valueOf() { valueOfCalls += 1; return 1; },
  toString() { valueOfCalls += 1; return '1'; },
};
assert.equal(
  semanticEvidenceItems([{ kind: 'write', confidence: coercing, evidence: [{ id: 'b', row: 3 }] }]).length,
  0,
);
assert.equal(valueOfCalls, 0, 'confidence coercion side effects must not run');

const arrayGrade = semanticEvidenceItems([{
  kind: 'write', confidence: 1, proofGrade: ['verified'], evidence: [{ id: 'c', row: 4 }],
}]);
assert.equal(arrayGrade.length, 1);
assert.equal(arrayGrade[0].family, FAMILY.USAGE, 'structured proofGrade must not mint VERIFIED');
assert.equal(arrayGrade[0].code, 'semantic-ir-observation');

let toStringCalls = 0;
const gradeObject = { toString() { toStringCalls += 1; return 'verified'; } };
const objectGrade = semanticEvidenceItems([{
  kind: 'write', confidence: 1, grade: gradeObject, evidence: [{ id: 'd', row: 5 }],
}]);
assert.equal(toStringCalls, 0, 'proofGrade toString side effects must not run');
assert.equal(objectGrade[0].family, FAMILY.USAGE);

const boxedGrade = semanticEvidenceItems([{
  kind: 'write', confidence: 1, proofGrade: new String('verified'), evidence: [{ id: 'e', row: 6 }],
}]);
assert.equal(boxedGrade[0].family, FAMILY.USAGE);

for (const metadata of [
  { proofGrade: ['verified'] },
  { grade: ['proof'] },
  { proofGrade: true },
  { proofGrade: 1 },
  { verified: ['true'] },
  { verified: 1 },
  { verificationOrigin: ['manual-audit'] },
  { verificationOrigin: { note: 'audited' } },
  { verificationOrigin: true },
  { verificationOrigin: 1 },
]) {
  const items = semanticEvidenceItems([{
    kind: 'write', confidence: 1, evidence: [{ id: 'f', row: 7 }], ...metadata,
  }]);
  for (const item of items) {
    assert.notEqual(item.family, FAMILY.VERIFIED, `malformed ${JSON.stringify(metadata)} must not mint VERIFIED`);
  }
}

const clamped = semanticEvidenceItems([{ kind: 'read', confidence: 0.5, evidence: [{ id: 'g', row: 8 }] }]);
assert.equal(clamped[0].strength, 0.5);
const overflow = semanticEvidenceItems([{ kind: 'read', confidence: 9, evidence: [{ id: 'h', row: 9 }] }]);
assert.equal(overflow[0].strength, 1);
assert.equal(semanticEvidenceItems([{ kind: 'read', confidence: NaN, evidence: [{ id: 'i', row: 10 }] }]).length, 0);
assert.equal(semanticEvidenceItems([{ kind: 'read', confidence: -2, evidence: [{ id: 'j', row: 11 }] }]).length, 0);

for (const grade of ['verified', 'proof', 'proof-grade', 'deterministic', 'VERIFIED']) {
  const items = semanticEvidenceItems([{
    kind: 'read', confidence: 1, proofGrade: grade, evidence: [{ id: 'k', row: 12 }],
  }]);
  assert.equal(items[0].family, FAMILY.VERIFIED);
  assert.equal(items[0].code, 'semantic-ir-proof');
}
const eLevelGrade = semanticEvidenceItems([{
  kind: 'read', confidence: 1, evidence: [{ id: 'l', row: 13, proofGrade: 'proof' }],
}]);
assert.equal(eLevelGrade[0].family, FAMILY.VERIFIED);
const strictVerified = semanticEvidenceItems([{
  kind: 'read', confidence: 1, verified: true, evidence: [{ id: 'm', row: 14 }],
}]);
assert.equal(strictVerified[0].family, FAMILY.VERIFIED);
const originString = semanticEvidenceItems([{
  kind: 'read', confidence: 1, verificationOrigin: 'manual-audit', evidence: [{ id: 'n', row: 15 }],
}]);
assert.equal(originString[0].family, FAMILY.VERIFIED);

const weighted = semanticEvidenceItems([{
  kind: 'read', confidence: 0.8, evidence: [{ id: 'o', row: 16 }],
}], { lr: 18 });
assert.equal(weighted[0].strength, 0.8);
assert.equal(weighted[0].lr, 4);
const proofWeighted = semanticEvidenceItems([{
  kind: 'read', confidence: 0.8, verified: true, evidence: [{ id: 'p', row: 17 }],
}], { lr: 18 });
assert.equal(proofWeighted[0].lr, 18);

console.log('issue-4649-semantic-proof-metadata-types: ok');
