import test from 'node:test';
import assert from 'node:assert/strict';
import { symbolicExecute } from '../../../js/symbolic/index.js';
import { OP } from '../../../js/ir-base.js';
import { scalarFixture, identity } from '../taint/fixtures.mjs';
const run = (ir, options = {}) => symbolicExecute(ir, { captureValues: true, byteMemory: { identity }, ...options });

test('a pure definition outside the execution stream is not silently evaluated', () => {
  const ir = scalarFixture(), ghost = { id: 'ghost', bits: 8 };
  const instruction = { id: 'not-in-ir', op: OP.MOV, args: [{ value: { id: 'ghost-source', bits: 8, const: 42n } }], dst: ghost };
  ghost.def = instruction;
  ir.blocks[0].insts.at(-1).args = [{ value: ghost }];
  const result = run(ir);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.paths, []);
  assert.equal(result.reason, 'value-definition-not-executed');
});

test('pure operations without destinations cannot be skipped as complete no-ops', () => {
  const ir = scalarFixture();
  ir.blocks[0].insts[0].dst = null;
  ir.blocks[0].insts.at(-1).args = [{ value: { id: 'constant-ret', bits: 8, const: 0n } }];
  const result = run(ir);
  assert.equal(result.status, 'partial');
  assert.equal(result.reason, 'missing-instruction-destination');
});

test('unsupported execution plus an exhausted publication budget returns partial, not a throw', () => {
  const ir = scalarFixture();ir.blocks[0].insts[0].op=OP.UN;ir.blocks[0].insts[0].sub='not-supported';
  for (const workItems of [134,135,140,150,200,225,230,231,235,300,400,500,1000,1500]) {
    let result;
    assert.doesNotThrow(() => { result = run(ir, { byteMemory: { identity, limits: { workItems } } }); }, `workItems=${workItems}`);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.paths, []);
  }
});
