import assert from 'node:assert/strict';
import { liftArm64MemoryEffects } from '../../js/targets/architecture/arm64/effects/memory.js';

let sequence = 0;
const x = (n) => ({ k:'reg', text:`x${n}`, cls:'gp', bits:64, num:n });
const w = (n) => ({ k:'reg', text:`w${n}`, cls:'gp', bits:32, num:n });
const sp = () => ({ k:'reg', text:'sp', cls:'sp', bits:64, num:31 });
const fp = (prefix, n, bits) => ({ k:'reg', text:`${prefix}${n}`, cls:'fp', bits, num:n });
const imm = (value) => ({ k:'imm', text:`#${value}`, value:BigInt(value) });
const mem = (base) => ({
  k:'mem', text:'[...]', base, index:null, shift:null, mode:'offset',
  disp:imm(0), addressDisp:imm(0), writebackDisp:null,
});
function lift(mnemonic, ops, extra = {}) {
  const instructionId = `issue-4178-${sequence++}`;
  return liftArm64MemoryEffects(
    { mnemonic, ops, ...extra },
    { instructionId, origin:{ instructionIds:[instructionId] } },
  );
}
const alignmentFaults = (bundle) => bundle.possibleFaults.filter((fault) => fault.kind === 'alignment-fault');
const memoryOps = (bundle) => bundle.operations.filter((op) => op.kind === 'memory-read' || op.kind === 'memory-write');

for (const [mnemonic, reg, expectedAlignment] of [
  ['ldrb', w(0), 1],
  ['ldrh', w(0), 2],
  ['str', w(0), 4],
  ['ldr', x(0), 8],
  ['str', fp('q', 0, 128), 16],
]) {
  const bundle = lift(mnemonic, [reg, mem(x(1))]);
  assert.equal(bundle.completeness, 'exact');
  const faults = alignmentFaults(bundle);
  if (expectedAlignment === 1) {
    assert.equal(faults.length, 0, `${mnemonic} byte access cannot be misaligned`);
  } else {
    assert.equal(faults.length, 1, `${mnemonic} retains runtime alignment-fault possibility`);
    assert.equal(faults[0].condition.alignment, expectedAlignment);
    assert.equal(faults[0].condition.accessIndex, 0);
    const abort = bundle.possibleFaults.find((fault) => fault.kind === 'data-abort');
    assert.ok(abort?.detail?.causes?.includes('alignment'), `${mnemonic} Data Abort causes include alignment`);
  }
}

{
  const bundle = lift('ldr', [x(0), mem(x(1))]);
  const [access] = memoryOps(bundle);
  assert.equal('alignment' in access.access, false, 'ordinary LDR does not become an always-aligned access');
}

for (const mnemonic of ['ldar','stlr']) {
  const bundle = lift(mnemonic, [x(0), mem(x(1))]);
  const [access] = memoryOps(bundle);
  assert.equal(access.access.alignment, 8, `${mnemonic} keeps its strict access-alignment contract`);
  assert.equal(alignmentFaults(bundle)[0]?.condition?.alignment, 8);
}

for (const mnemonic of ['ldp','ldnp','stp','stnp']) {
  const bundle = lift(mnemonic, [x(0), x(1), mem(x(2))]);
  const faults = alignmentFaults(bundle);
  assert.equal(bundle.completeness, 'exact');
  assert.equal(faults.length, 2, `${mnemonic} models one alignment possibility per element access`);
  assert.deepEqual(faults.map((fault) => fault.condition.alignment), [8,8]);
  assert.deepEqual(faults.map((fault) => fault.condition.accessIndex), [0,1]);
  for (const access of memoryOps(bundle)) {
    assert.equal('alignment' in access.access, false, `${mnemonic} pair access is not made unconditionally aligned`);
  }
}

for (const [reg, widthBits, expectedAlignment] of [[x(0),64,8],[fp('q', 0, 128),128,16]]) {
  const bundle = lift('ldr', [reg, imm(0x1004n)], { literalTarget:0x1004n });
  assert.equal(bundle.completeness, 'exact');
  assert.equal(memoryOps(bundle)[0].access.widthBits, widthBits);
  assert.equal(alignmentFaults(bundle)[0]?.condition?.alignment, expectedAlignment, 'literal access keeps natural-width alignment possibility');
}

{
  const bundle = lift('ldr', [x(0), mem(sp())]);
  assert.ok(bundle.possibleFaults.some((fault) => fault.kind === 'stack-pointer-alignment-fault'), 'CheckSPAlignment remains separate');
  assert.equal(alignmentFaults(bundle)[0]?.condition?.alignment, 8, 'memory access alignment remains element-width based');
}
