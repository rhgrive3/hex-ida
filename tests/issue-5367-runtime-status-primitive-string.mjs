import assert from 'node:assert/strict';
import { runtimeEvidenceItems } from '../js/semantic-evidence.js';
import { FAMILY } from '../js/evidence.js';

// #5367: a structured runtime status must not launder into a completion alias
// via String() coercion — String(['complete']) === 'complete' and custom
// toString() objects minted VERIFIED evidence from schema-external shapes.

// Array status: rejected as a completion alias.
assert.equal(runtimeEvidenceItems({
  status: ['complete'],
  touchedFields: [{ address: 0x20n }],
}).length, 0);

// Custom toString() object status: rejected, and its side effects must not run
// during the verification decision.
let toStringCalls = 0;
assert.equal(runtimeEvidenceItems({
  status: { toString() { toStringCalls += 1; return 'success'; } },
  takenBranches: [{ row: 1 }],
}).length, 0);
assert.equal(toStringCalls, 0);

// Numeric status is not an alias either.
assert.equal(runtimeEvidenceItems({
  status: 1,
  touchedFields: [{ address: 0x20n }],
}).length, 0);

// Failure shapes that happen to coerce through String() stay fail-closed.
assert.equal(runtimeEvidenceItems({
  status: ['timeout'],
  touchedFields: [{ address: 0x20n }],
}).length, 0);

// Primitive status aliases keep working.
const field = runtimeEvidenceItems({
  status: 'complete',
  touchedFields: [{ address: 0x20n }],
});
assert.equal(field.length, 1);
assert.equal(field[0].code, 'runtime-field-verified');
assert.equal(field[0].family, FAMILY.VERIFIED);
assert.equal(field[0].kind, 'verified');

const branch = runtimeEvidenceItems({
  state: 'Success',
  takenBranches: [{ row: 1 }],
});
assert.equal(branch.length, 1);
assert.equal(branch[0].code, 'runtime-branch-verified');
assert.equal(branch[0].family, FAMILY.VERIFIED);

// Empty-string status falls through to the state alias, as before.
assert.equal(runtimeEvidenceItems({
  status: '',
  state: 'complete',
  touchedFields: [{ address: 0x20n }],
}).length, 1);

// Strict boolean completion flags are unchanged.
assert.equal(runtimeEvidenceItems({
  ok: true,
  touchedFields: [{ address: 0x20n }],
}).length, 1);
assert.equal(runtimeEvidenceItems({
  complete: true,
  touchedFields: [{ address: 0x20n }],
}).length, 1);

// Explicit failure markers stay fail-closed.
for (const bad of [
  { ok: false, touchedFields: [{ address: 0x20n }] },
  { status: 'timeout', touchedFields: [{ address: 0x20n }] },
  { status: 'failed', touchedFields: [{ address: 0x20n }] },
  { truncated: true, ok: true, touchedFields: [{ address: 0x20n }] },
  { complete: false, touchedFields: [{ address: 0x20n }] },
]) {
  assert.equal(runtimeEvidenceItems(bad).length, 0);
}

console.log('issue-5367 runtime status primitive-string contract: ok');
