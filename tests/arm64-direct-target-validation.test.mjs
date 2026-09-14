import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../js/targets/architecture/arm64/effects/index.js';

let caseId = 0;
function lift(mnemonic, ops, extra = {}) {
  caseId += 1;
  return liftArm64MachineEffects({
    instructionId: `arm64-direct-target-${mnemonic}-${caseId}`,
    mnemonic,
    mode: 'a64',
    address: 0n,
    ops,
    ...extra,
  });
}

function assertExactTarget(bundle, kind, value) {
  assert.equal(bundle?.completeness, 'exact');
  assert.equal(bundle?.controlEffect?.kind, kind);
  assert.equal(bundle?.controlEffect?.target?.kind, 'absolute-address');
  assert.equal(bundle?.controlEffect?.target?.value, String(value));
}

for (const text of ['4096', '#4096', '0x1000', '#0x1000']) {
  assertExactTarget(lift('b', [{ k:'other', text }]), 'branch', 4096);
}
assertExactTarget(lift('b', [{ k:'imm', value:4096n }]), 'branch', 4096);
assertExactTarget(lift('bl', [{ k:'other', text:'4096' }]), 'call', 4096);

const conditional = lift('cbz', [
  { k:'reg', cls:'gp', num:0, bits:64, text:'x0' },
  { k:'other', text:'4096' },
]);
assert.equal(conditional?.completeness, 'exact');
assert.equal(conditional?.controlEffect?.kind, 'conditional-branch');
assert.equal(conditional?.controlEffect?.target?.value, '4096');

const malformedTexts = [
  ['4096'],
  { toString() { return '4096'; } },
  true,
  4096,
];
for (const text of malformedTexts) {
  for (const mnemonic of ['b', 'bl']) {
    const bundle = lift(mnemonic, [{ k:'other', text }]);
    assert.equal(bundle?.completeness, 'partial');
    assert.equal(bundle?.controlEffect?.kind, 'unknown');
    assert.equal(bundle?.unknownEffects?.reason, `arm64-${mnemonic}-operand-shape-invalid`);
  }
  const bundle = lift('cbz', [
    { k:'reg', cls:'gp', num:0, bits:64, text:'x0' },
    { k:'other', text },
  ]);
  assert.equal(bundle?.completeness, 'partial');
  assert.equal(bundle?.controlEffect?.kind, 'unknown');
  assert.equal(bundle?.unknownEffects?.reason, 'arm64-cbz-operand-shape-invalid');
}

const whitespace = lift('b', [{ k:'other', text:'   ' }]);
assert.equal(whitespace?.completeness, 'partial');
assert.equal(whitespace?.unknownEffects?.reason, 'arm64-b-operand-shape-invalid');

const misaligned = lift('b', [{ k:'other', text:'4097' }]);
assert.equal(misaligned?.completeness, 'partial');
assert.equal(misaligned?.unknownEffects?.reason, 'arm64-b-target-misaligned-encoding');

console.log('arm64 direct target validation tests passed');
