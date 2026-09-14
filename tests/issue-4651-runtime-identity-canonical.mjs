import assert from 'node:assert/strict';
import { runtimeEvidenceItems } from '../js/semantic-evidence.js';
import { FAMILY } from '../js/evidence.js';

// #4651: runtime field/branch identity must be a canonical primitive. The dedupe
// key was built with a generic String() coercion, so String(['4096']) === '4096'
// let a structured identity alias into a legitimate one and mint FAMILY.VERIFIED
// evidence from malformed provider/sandbox output.

// Structured address identity never produces VERIFIED evidence.
assert.equal(runtimeEvidenceItems({
  ok: true,
  touchedFields: [{ address: ['4096'] }],
}, { strength: 1 }).length, 0, 'array address identity is rejected');

assert.equal(runtimeEvidenceItems({
  ok: true,
  touchedFields: [{ offset: { valueOf: 4096 } }],
}, { strength: 1 }).length, 0, 'object offset identity is rejected');

assert.equal(runtimeEvidenceItems({
  ok: true,
  takenBranches: [{ row: ['1'] }],
}, { strength: 1 }).length, 0, 'array row identity is rejected');

assert.equal(runtimeEvidenceItems({
  ok: true,
  takenBranches: [{ address: { toString() { return '4096'; } } }],
}, { strength: 1 }).length, 0, 'toString() object identity is rejected');

let identityToStringCalls = 0;
assert.equal(runtimeEvidenceItems({
  ok: true,
  touchedFields: [{ address: { toString() { identityToStringCalls += 1; return '4096'; } } }],
}, { strength: 1 }).length, 0);
assert.equal(identityToStringCalls, 0, 'identity coercion side effects must not run');

// A structured identity must not shadow (alias into) a legitimate identity and
// must not displace the canonical item that shares the coerced key.
const aliased = runtimeEvidenceItems({
  ok: true,
  touchedFields: [{ address: ['4096'] }, { address: 0x1000n }],
}, { strength: 1 });
assert.equal(aliased.length, 1);
assert.equal(aliased[0].code, 'runtime-field-verified');
assert.equal(aliased[0].family, FAMILY.VERIFIED);
assert.equal(aliased[0].detail.address, 0x1000n, 'the canonical item is the one kept');

// Non-integer / out-of-domain / non-primitive primitives are malformed too.
for (const bad of [
  { address: 1.5 },
  { address: Number.NaN },
  { address: Infinity },
  { address: 2 ** 53 },
  { address: -1 },
  { address: '0x1.8' },
  { address: '4096n' },
  { address: '' },
  { address: '   ' },
  { address: 'counter' },
  { address: true },
  { address: Symbol.for('hex.field') },
]) {
  assert.equal(runtimeEvidenceItems({ ok: true, touchedFields: [bad] }, { strength: 1 }).length, 0,
    `malformed field identity ${String(bad.address)} is rejected`);
}
for (const bad of [{ row: 1.5 }, { row: -1 }, { row: ['7'] }, { row: true }, { row: {} }]) {
  assert.equal(runtimeEvidenceItems({ ok: true, takenBranches: [bad] }, { strength: 1 }).length, 0,
    'malformed branch identity is rejected');
}

// Canonical primitive address/offset/key identities keep working, with the same
// authority weight as before (#4651 must not weaken runtime verification).
const canonical = runtimeEvidenceItems({
  completed: true,
  touchedFields: [{ address: 0x1000n, before: 1n, after: 2n }],
  takenBranches: [{ row: 7 }],
}, { strength: 1, lr: 18 });
assert.equal(canonical.length, 2);
assert.equal(canonical[0].code, 'runtime-field-verified');
assert.equal(canonical[0].family, FAMILY.VERIFIED);
assert.equal(canonical[0].strength, 1);
assert.equal(canonical[0].lr, 18);
assert.deepEqual(canonical[0].detail, { address: 0x1000n, before: 1n, after: 2n, group: 'runtime' });
assert.equal(canonical[1].code, 'runtime-branch-verified');
assert.equal(canonical[1].family, FAMILY.VERIFIED);
assert.equal(canonical[1].strength, 1);
assert.equal(canonical[1].lr, Math.sqrt(18));
assert.deepEqual(canonical[1].detail, { row: 7, group: 'runtime' });

// Equivalent canonical spellings of one identity dedupe into one item instead of
// double-counting the same runtime fact.
const spellings = runtimeEvidenceItems({
  ok: true,
  touchedFields: [{ address: 0x1000 }, { address: '0x1000' }, { address: '4096' }],
}, { strength: 1 });
assert.equal(spellings.length, 1);
assert.equal(spellings[0].family, FAMILY.VERIFIED);

// Distinct canonical identities still produce distinct items.
assert.equal(runtimeEvidenceItems({
  ok: true,
  touchedFields: [{ address: 0x1000n }, { address: 0x2000n }, { offset: 8 }, { key: 'counter' }],
}, { strength: 1 }).length, 4);

// A malformed entry never blocks the well-formed ones in the same result.
const mixed = runtimeEvidenceItems({
  ok: true,
  touchedFields: [{ address: ['4096'] }, { address: 0x3000n }],
  takenBranches: [{ row: {} }, { row: 3 }],
}, { strength: 1 });
assert.equal(mixed.length, 2);
assert.deepEqual(mixed.map((x) => x.code), ['runtime-field-verified', 'runtime-branch-verified']);

console.log('issue-4651 runtime identity canonical-primitive contract: ok');
