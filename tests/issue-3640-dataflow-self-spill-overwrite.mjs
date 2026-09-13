import assert from 'node:assert/strict';
import { selfRegisters } from '../js/dataflow-legacy.js';

const slot = { base: 'sp', disp: 0x10n, indexed: false, stack: true };
const slot2 = { base: 'sp', disp: 0x18n, indexed: false, stack: true };
const gpr = (n) => ({ k: 'reg', cls: 'gp', num: n });
const store = (row, num, mem = slot) => ({ row, mnemonic: 'str', reads: ['x' + num], writes: [], ops: [gpr(num)], memory: { ...mem, kind: 'store' } });
const storeRaw = (row, ops, mem = slot) => ({ row, mnemonic: 'str', reads: [], writes: [], ops, memory: { ...mem, kind: 'store' } });
const load = (row, num, mem = slot) => ({ row, mnemonic: 'ldr', reads: ['sp'], writes: ['x' + num], ops: [gpr(num)], memory: { ...mem, kind: 'load' } });
const model = (instructions) => ({ calls: [], instructions });

{
  const self = selfRegisters(model([store(0, 0), load(1, 19)]));
  assert.equal(self.isSelf('x19', 2), true, 'self spill + reload must propagate');
  assert.ok(self.set.has('x19'));
}

{
  const self = selfRegisters(model([store(0, 0), store(1, 1), load(2, 19)]));
  assert.equal(self.isSelf('x19', 3), false, 'overwrite of spill slot by non-self value must kill slot provenance');
}

{
  const self = selfRegisters(model([store(0, 0), store(1, 1), store(2, 0), load(3, 20)]));
  assert.equal(self.isSelf('x20', 4), true, 'slot provenance must follow the last store');
}

{
  const self = selfRegisters(model([store(0, 0), storeRaw(1, [{ k: 'imm', value: 4n }]), load(2, 19)]));
  assert.equal(self.isSelf('x19', 3), false, 'store of an unresolvable source must fail-closed invalidate the slot');
}

{
  const self = selfRegisters(model([store(0, 0, slot2), load(1, 19)]));
  assert.equal(self.isSelf('x19', 2), false, 'reload from an untouched slot must not be self');
}

{
  const self = selfRegisters(model([store(0, 0), load(1, 19), store(2, 1), load(3, 20)]));
  assert.equal(self.isSelf('x19', 2), true, 'earlier reload keeps its historic self span');
  assert.equal(self.isSelf('x20', 4), false, 'later non-self reload must not be self');
}

{
  const self = selfRegisters(model([
    { row: 0, mnemonic: 'str', reads: ['x0'], writes: [], ops: [gpr(0)], memory: { base: 'x1', disp: 0x10n, indexed: false, kind: 'store' } },
    load(1, 19),
  ]));
  assert.equal(self.isSelf('x19', 2), false, 'non-stack store must not create spill provenance');
}

console.log('issue-3640 self stack-spill overwrite kill: PASS');
