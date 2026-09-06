import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { dispatchX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { canonicalX86ConditionCode } from '../../js/targets/architecture/x86_64/effects/flags.js';

const indexSource = readFileSync(new URL('../../js/targets/architecture/x86_64/effects/index.js', import.meta.url), 'utf8');

function makeX86(family, mnemonic = family, operands = []) {
  return createX86DecodedInstruction({
    address: 0x1000n,
    length: 3,
    rawBytes: new Uint8Array([0x0f, 0x01, 0xe8]),
    mode: 'long-64',
    instructionId: family,
    instructionCode: 1,
    instructionFamily: family,
    mnemonic,
    detailAvailable: true,
    detailStatus: 'complete',
    detail: { operandCount: operands.length, operands, implicitReads: [], implicitWrites: [] },
  });
}

// SETcc is a finite ISA family.  SETSSBSY and arbitrary set* spellings must
// never acquire integer/condition-code authority from the mnemonic prefix.
for (const condition of ['o','no','b','ae','e','ne','be','a','s','ns','p','np','l','ge','le','g']) {
  assert.ok(canonicalX86ConditionCode(condition), `SET${condition.toUpperCase()} condition must remain recognized`);
}
assert.equal(canonicalX86ConditionCode('ssbsy'), null);
assert.equal(canonicalX86ConditionCode('definitely-not-a-condition'), null);

// Behavioral dispatch: Genuine canonical SETcc instructions must retain integer owner
for (const cc of ['sete', 'setne', 'setb', 'setae']) {
  const inst = makeX86(cc, cc, [
    { type: 'register', register: 'al', access: 'write' },
  ]);
  const dispatched = dispatchX86MachineEffects(inst);
  assert.equal(dispatched.ownerId, 'integer', `${cc} must maintain integer owner`);
  assert.ok(dispatched.result, `${cc} must have a valid result`);
  assert.equal(dispatched.result.completeness, 'exact', `${cc} must have exact completeness`);
}

// Behavioral dispatch: Trusted structured SETSSBSY must route to system owner and remain partial
const setssbsy = makeX86('setssbsy', 'setssbsy');
const dispatchedSetssbsy = dispatchX86MachineEffects(setssbsy);
assert.equal(dispatchedSetssbsy.ownerId, 'system', 'SETSSBSY must route to system owner');
assert.ok(dispatchedSetssbsy.result != null, 'SETSSBSY must produce a result from system owner');
assert.equal(dispatchedSetssbsy.result.completeness, 'partial', 'SETSSBSY must remain partial');
assert.notEqual(dispatchedSetssbsy.result.completeness, 'exact', 'SETSSBSY must not be exact');
assert.notEqual(dispatchedSetssbsy.result.completeness, 'exact-with-intrinsic', 'SETSSBSY must not be exact-with-intrinsic');
assert.equal(
  dispatchedSetssbsy.result.unknownEffects?.reason,
  'x86-extended-system-family-requires-dedicated-semantics',
  'SETSSBSY must preserve system fail-closed reason',
);
assert.equal(dispatchedSetssbsy.result.metadata?.failClosed, true);
assert.equal(dispatchedSetssbsy.result.metadata?.exactArchitecturalSummary, false);

// Behavioral dispatch: Unknown non-SETcc set* instructions must fail closed to fallback without exact semantic authority
for (const fakeSet of ['setunknown', 'setxyz', 'setfoo']) {
  const inst = makeX86(fakeSet, fakeSet);
  const dispatched = dispatchX86MachineEffects(inst);
  assert.equal(dispatched.ownerId, 'fallback', `${fakeSet} must route to fallback`);
  assert.equal(dispatched.result, null, `${fakeSet} must not gain exact semantic authority`);
}

assert.match(indexSource, /instructionFamily\.startsWith\('set'\)\s*&&\s*!isCanonicalSetccFamily\(instructionFamily\)/);
assert.match(indexSource, /const systemSet = liftX86SystemEffects\(instruction, context\)/);
assert.match(indexSource, /ownerId:'system', result:terminalize\(instruction, 'system', systemSet, context\)/);
assert.match(indexSource, /x86-extended-system-family-requires-dedicated-semantics/);

console.log('issue-5566-x86-setssbsy-routing: PASS');

