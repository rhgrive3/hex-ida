import test from 'node:test';
import assert from 'node:assert/strict';
import { symbolicExecute, translate } from '../../../js/symbolic/index.js';
import { OP } from '../../../js/ir-base.js';
import { identity, scalarFixture, integrationFixture } from '../taint/fixtures.mjs';

const run = (ir, options = {}) => symbolicExecute(ir, { captureValues: true,
  byteMemory: { identity, addressBits: 8, wrapping: 'modular' }, ...options });
const rejected = (ir, reason) => {
  const result = run(ir);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.paths, []);
  assert.equal(result.reason, reason);
};

export function forkFixture() {
  const control = { id: 'control', kind: 'arg', reg: 'x0', index: 0, bits: 8 };
  const local = { id: 'only-yes-input', kind: 'arg', reg: 'x1', index: 1, bits: 8 };
  const pointer = { id: 'only-yes-pointer', bits: 8 };
  const branch = { op: OP.CBR, args: [{ value: control }], extra: { kind: 'cbnz', target: 4n }, row: 0, address: 0n };
  const move = { op: OP.MOV, args: [{ value: local }], dst: pointer, row: 1, address: 4n }; pointer.def = move;
  const yes = { op: OP.RET, args: [{ value: pointer }], row: 2, address: 8n };
  const no = { op: OP.RET, args: [{ value: { id: 'no-result', bits: 8, const: 22n } }], row: 3, address: 12n };
  const ir = { entry: 0, blocks: [
    { index: 0, insts: [branch], succ: [1, 2] },
    { index: 1, insts: [move, yes], succ: [] },
    { index: 2, insts: [no], succ: [] },
  ], instructions: [branch, move, yes, no] };
  return { ir, local, pointer };
}

test('IR accessors are rejected before preflight can execute them', () => {
  for (const location of ['blocks', 'args']) {
    const ir = scalarFixture(); let reads = 0;
    const object = location === 'blocks' ? ir : ir.blocks[0].insts[0];
    const saved = object[location];
    Object.defineProperty(object, location, { enumerable: true, configurable: true,
      get() { reads++; return saved; } });
    rejected(ir, 'ir-accessor');
    assert.equal(reads, 0, location);
  }
});

test('a non-PHI side effect in the PHI area is not silently ignored', () => {
  const ir = scalarFixture(); ir.blocks[0].phis = [{ op: OP.CALL, args: [] }];
  rejected(ir, 'invalid-phi-instruction');
});

test('PHI definitions and placement have the same authority as ordinary definitions', () => {
  const ir = integrationFixture(), phi = ir.blocks[3].phis[0];
  phi.dst.def = { ...phi };
  rejected(ir, 'instruction-definition-mismatch');
  const placed = integrationFixture(), misplaced = placed.blocks[3].phis.pop();
  placed.blocks[3].insts.unshift(misplaced);
  rejected(placed, 'phi-outside-entry');
});

test('PHI predecessor set and destination uniqueness are producer facts, not first-match guesses', () => {
  const ir = integrationFixture(), phi = ir.blocks[3].phis[0];
  phi.incoming.push({ from: 99, value: phi.incoming[0].value });
  rejected(ir, 'ambiguous-phi');
  const duplicate = integrationFixture();
  duplicate.blocks[3].phis.push(duplicate.blocks[3].phis[0]);
  rejected(duplicate, 'duplicate-instruction');
});

test('a sibling branch cannot make a never-evaluated argument an executed snapshot target', () => {
  const { ir, local } = forkFixture(), result = run(ir);
  assert.equal(result.status, 'complete', result.reason); assert.equal(result.paths.length, 2);
  const sibling = result.paths.find(path => path.returnValue.kind === 'const');
  const value = translate.translateSemanticIR(local, { ir, identity, executionSnapshot: sibling.snapshot });
  assert.equal(value.status, 'unsupported');
  assert.equal(value.reason, 'target-not-executed-in-snapshot');
});

test('terminal memory addresses must have executed on that path, not only on a sibling', () => {
  const { ir } = forkFixture();
  const result = run(ir, { memoryObservations: [{ id: 'output', addressValueId: 'only-yes-pointer', size: 1 }] });
  assert.equal(result.status, 'partial'); assert.deepEqual(result.paths, []);
  assert.equal(result.reason, 'observation-address-not-executed');
});

test('machine width and compatibility value width cannot contradict each other', () => {
  const ir = scalarFixture();
  ir.blocks[0].insts[0].args[0].value.machineType = { kind: 'bitvector', widthBits: 16 };
  rejected(ir, 'machine-value-width-mismatch');
});

test('path-local observation does not split the canonical identity of a shared input', () => {
  const { ir, local } = forkFixture();
  ir.blocks[2].insts[0].args = [{ value: local }];
  const result = run(ir);
  assert.equal(result.status, 'complete', result.reason); assert.equal(result.paths.length, 2);
  assert.equal(result.paths[0].returnValue, result.paths[1].returnValue,
    'the same semantic input must retain one canonical Expr even when first read after a fork');
});
