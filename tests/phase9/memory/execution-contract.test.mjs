import test from 'node:test';
import assert from 'node:assert/strict';
import { symbolicExecute } from '../../../js/symbolic/index.js';
import { OP } from '../../../js/ir-base.js';
import { identity, scalarFixture, integrationFixture } from '../taint/fixtures.mjs';
import { isExecutionResult, isExecutionSnapshot } from '../../../js/symbolic/memory/execution-snapshot.js';
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

function withPhiUses() {
  const ir = integrationFixture(), phi = ir.blocks[3].phis[0];
  phi.args = phi.incoming.map(({ value }) => ({ value, bits:value.bits }));
  return { ir, phi };
}

test('PHI use-list operands preserve predecessor selection and are never evaluated eagerly', () => {
  for (const byte of [0n, 7n]) {
    const { ir, phi } = withPhiUses();
    const incoming = phi.incoming.map(item => item.value), uses = phi.args.slice();
    const result = symbolicExecute(ir, { symbolicArgs:{ 0:0n, 1:0x1234n, 2:byte },
      captureValues:true, byteMemory:{ identity, addressBits:8, wrapping:'modular' } });
    assert.equal(result.status, 'complete', result.reason);
    assert.equal(result.paths.length, 1);
    assert.equal(result.paths[0].returnValue.value, byte);
    assert.deepEqual(phi.incoming.map(item => item.value), incoming);
    assert.deepEqual(phi.args, uses);
    assert.ok(phi.args.every((arg, index) => arg === uses[index] && arg.value === incoming[index]));
  }
});

for (const [name, change] of [
  ['missing operand', phi => phi.args.pop()],
  ['extra operand', phi => phi.args.push(phi.args[0])],
  ['reordered operand', phi => phi.args.reverse()],
  ['copied value identity', phi => { phi.args[0].value = { ...phi.args[0].value }; }],
  ['contradictory width', phi => { phi.args[0].bits = 16; }],
  ['coerced width', phi => { phi.args[0].bits = '8'; }],
  ['zero shift metadata', phi => { phi.args[0].shift = 0; }],
  ['shifted value', phi => { phi.args[0].shift = { kind:'lsl', amount:1 }; }],
  ['extended value', phi => { phi.args[0].extend = 'uxtb'; }],
  ['extra argument metadata', phi => { phi.args[0].other = true; }],
  ['non-enumerable modifier', phi => { Object.defineProperty(phi.args[0], 'shift', { value:1 }); }],
  ['sparse args', phi => { delete phi.args[0]; }],
  ['array modifier', phi => { phi.args.shiftMode = 'lsl'; }],
  ['array symbol', phi => { phi.args[Symbol('modifier')] = 1; }],
]) test(`PHI use-list contradictions cannot publish execution: ${name}`, () => {
  const { ir, phi } = withPhiUses(); change(phi);
  partial(ir, 'invalid-phi-use-list');
});

test('populated PHI uses do not weaken predecessor coverage or definition identity', () => {
  const wrongEdge = withPhiUses(); wrongEdge.phi.incoming[0].from = 99;
  partial(wrongEdge.ir, 'ambiguous-phi');
  const copiedDefinition = withPhiUses(); copiedDefinition.phi.dst.def = { ...copiedDefinition.phi };
  partial(copiedDefinition.ir, 'instruction-definition-mismatch');
  const wrongWidth = withPhiUses(); wrongWidth.phi.dst.bits = 16;
  partial(wrongWidth.ir, 'semantic-value-width-conflict');
});

test('PHI use-list additions revoke issued execution and snapshots without invoking accessors', () => {
  for (const mutate of [
    phi => { phi.args[0].shift = 1; },
    phi => { Object.defineProperty(phi.args[0], 'modifier', { value:1 }); },
    phi => { phi.args[0][Symbol('modifier')] = 1; },
    phi => { Object.defineProperty(phi.args[0], 'modifier', { get() { assert.fail('must not invoke accessor'); } }); },
    phi => { phi.args.modifier = 1; },
    phi => { phi.args[Symbol('modifier')] = 1; },
  ]) {
    const { ir, phi } = withPhiUses();
    const result = symbolicExecute(ir, { symbolicArgs:{ 0:0n, 1:0x1234n, 2:7n },
      captureValues:true, byteMemory:{ identity, addressBits:8 } });
    assert.equal(result.status, 'complete', result.reason);
    assert.equal(isExecutionResult(result, identity, ir), true);
    const snapshot = result.paths[0].snapshot;
    assert.equal(isExecutionSnapshot(snapshot, identity, ir), true);
    mutate(phi);
    assert.equal(isExecutionResult(result, identity, ir), false);
    assert.equal(isExecutionSnapshot(snapshot, identity, ir), false);
  }
});

test('a final cancellation callback cannot add a PHI operand modifier after validation', () => {
  const runWith = (ir, isCancelled) => symbolicExecute(ir, { symbolicArgs:{ 0:0n, 1:0x1234n, 2:7n },
    captureValues:true, byteMemory:{ identity, addressBits:8, isCancelled } });
  let calls = 0;
  const baseline = runWith(withPhiUses().ir, () => { calls++; return false; });
  assert.equal(baseline.status, 'complete', baseline.reason);
  for (const offset of [0, 1, 2, 3]) {
    const { ir, phi } = withPhiUses(); let current = 0;
    const result = runWith(ir, () => {
      if (++current === calls - offset) phi.args[0].shift = 1;
      return false;
    });
    assert.ok(Object.hasOwn(phi.args[0], 'shift'), 'the final callback must actually run');
    assert.equal(result.status, 'partial', `${offset}: ${result.reason}`);
    assert.deepEqual(result.paths, []);
  }
});
