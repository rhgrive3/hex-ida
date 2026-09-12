import test from 'node:test';
import assert from 'node:assert/strict';
import { symbolicExecute } from '../../../js/symbolic/index.js';
import { OP } from '../../../js/ir-base.js';
import { identity, scalarFixture, integrationFixture } from '../taint/fixtures.mjs';
const run = ir => symbolicExecute(ir, { byteMemory: { identity, addressBits: 8, wrapping: 'modular' } });
const partial = (ir, reason) => {
  const result = run(ir);
  assert.equal(result.status, 'partial', reason);
  assert.equal(result.paths.length, 0, reason);
  if (reason) assert.equal(result.reason, reason);
};

test('upstream truncated IR cannot publish complete execution', () => {
  const ir = scalarFixture(); ir.truncated = true;
  partial(ir, 'incomplete-ir');
});
test('entry and block identities are not coerced or silently defaulted', () => {
  for (const entry of [NaN, false, '0', -1, 1.5, 99]) {
    const ir = scalarFixture(); ir.entry = entry;
    partial(ir, 'invalid-ir-entry');
  }
  const ir = scalarFixture(); ir.blocks[0].index = 7;
  partial(ir, 'invalid-ir-block-index');
});
test('a branch target must be an authenticated edge of the supplied CFG', () => {
  const ir = integrationFixture(); ir.blocks[0].succ = [2, 3];
  partial(ir, 'branch-target-not-successor');
});
test('duplicate successor and ambiguous block address cannot mint extra paths', () => {
  const duplicate = integrationFixture(); duplicate.blocks[0].succ = [1, 1];
  partial(duplicate, 'invalid-ir-successor');
  const addresses = integrationFixture(); addresses.blocks[2].insts[0].address = 16n;
  partial(addresses, 'ambiguous-block-address');
});
test('multiple return values are not silently reduced to the first observable', () => {
  const ir = scalarFixture(); ir.blocks[0].insts[1].args.push({value:{id:'other',bits:8,const:9n}});
  partial(ir, 'unsupported-multi-return');
});
test('memory store with extra value operands cannot be silently accepted', () => {
  const ir = integrationFixture(); ir.blocks[0].insts[0].args.push({value:{id:'extra',bits:16,const:9n}});
  partial(ir, 'store-operand-arity');
});
test('an executed destination must name its real defining instruction', () => {
  const ir = scalarFixture(), inst = ir.blocks[0].insts[0];
  inst.dst.def = {...inst, op:OP.BIN, sub:'xor', args:[inst.args[0],inst.args[0]]};
  partial(ir, 'instruction-definition-mismatch');
});
test('effects after a basic-block terminator invalidate the execution input', () => {
  const ir = scalarFixture(); ir.blocks[0].insts.push({id:'late-call',op:OP.CALL,args:[]});
  partial(ir, 'instruction-after-terminator');
});
test('producer-declared incomplete scalar semantics cannot publish an exact path', () => {
  const ir = scalarFixture(); ir.blocks[0].insts[0].extra = {completeness:'partial'};
  partial(ir, 'incomplete-instruction');
});
