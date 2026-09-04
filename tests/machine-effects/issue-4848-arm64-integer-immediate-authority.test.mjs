import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { liftArm64IntegerEffects } from '../../js/targets/architecture/arm64/effects/integer.js';

let seq = 0;
const gp = (num, bits = 64) => ({ k:'reg', cls:'gp', num, bits, text:`${bits === 32 ? 'w' : 'x'}${num}` });
const imm = (value) => ({ k:'imm', value, text:'#1' });

function lift(mnemonic, ops) {
  const instructionId = `issue-4848:${mnemonic}:${++seq}`;
  return liftArm64MachineEffects({
    instructionId,
    mnemonic,
    mode:'a64',
    ops,
    origin:{ instructionIds:[instructionId] },
  });
}

function assertSemantic(bundle, label) {
  assert.ok(bundle, `${label}: integer family remains owned`);
  assert.notEqual(bundle.completeness, 'partial', `${label}: canonical bigint remains semantic`);
  assert.ok(bundle.operations.some((operation) => operation.kind !== 'unknown'), `${label}: canonical bigint emits definite semantics`);
}

function assertFailClosed(bundle, label) {
  assert.ok(bundle, `${label}: integer family remains owned`);
  assert.equal(bundle.completeness, 'partial', `${label}: non-bigint immediate is partial`);
  assert.equal(bundle.operations.length, 0, `${label}: malformed immediate emits no definite operation before rejection`);
  assert.match(bundle.unknownEffects?.reason || '', /immediate-value-unencodable$/);
  assert.equal(bundle.metadata?.failClosed, true);
}

const canonicalCases = [
  ['add', [gp(0), gp(1), imm(1n)]],
  ['and', [gp(0), gp(1), imm(1n)]],
  ['lsl', [gp(0), gp(1), imm(1n)]],
  ['movz', [gp(0), imm(1n)]],
  ['extr', [gp(0), gp(1), gp(2), imm(1n)]],
  ['ubfm', [gp(0), gp(1), imm(1n), imm(1n)]],
];

for (const [mnemonic, ops] of canonicalCases) {
  assertSemantic(lift(mnemonic, ops), `${mnemonic} bigint`);
}

let coercionCalled = false;
const malformedValues = [
  '1',
  1,
  true,
  [1],
  { toString() { coercionCalled = true; return '1'; } },
];

for (const malformed of malformedValues) {
  for (const [mnemonic, ops] of canonicalCases) {
    const poisoned = ops.map((op) => op.k === 'imm' ? { ...op, value:malformed } : op);
    assertFailClosed(lift(mnemonic, poisoned), `${mnemonic} ${typeof malformed}`);
  }
}
assert.equal(coercionCalled, false, 'integer immediate authority gate must not invoke object coercion');

const foreignInstructionId = `issue-4848:foreign:${++seq}`;
assert.equal(
  liftArm64IntegerEffects({
    instructionId:foreignInstructionId,
    mnemonic:'ldr',
    mode:'a64',
    ops:[imm('1')],
    origin:{ instructionIds:[foreignInstructionId] },
  }),
  null,
  'integer authority gate must not claim a non-integer family merely because it has an immediate',
);

console.log('issue-4848-arm64-integer-immediate-authority: PASS');
