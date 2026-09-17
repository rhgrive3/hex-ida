import test from 'node:test';
import assert from 'node:assert/strict';
import { symbolicExecute, translate } from '../../../js/symbolic/index.js';
import { OP } from '../../../js/ir-base.js';
import { scalarFixture, identity } from '../taint/fixtures.mjs';
import { translateMemoryScalar } from '../../../js/symbolic/translate/memory.js';
import { createBv } from '../../../js/symbolic/expr/index.js';
function fixture(literal = {}) {
  const ir = scalarFixture(), inst = ir.blocks[0].insts[0];
  inst.op = OP.CONST; inst.args = []; Object.assign(inst, literal);
  return { ir, inst };
}
const run = ir => symbolicExecute(ir, { captureValues: true, byteMemory: { identity } });
const value = (ir, inst, result) => translate.translateSemanticIR(inst, { ir, identity, executionSnapshot: result.paths[0].snapshot });

test('missing or unsafe CONST payloads cannot become exact zero or rounded integers', () => {
  for (const literal of [{}, { value: Number.MAX_SAFE_INTEGER + 1 }]) {
    const { ir } = fixture(literal), result = run(ir);
    assert.equal(result.status, 'partial'); assert.deepEqual(result.paths, []);
  }
});
test('declared machine-compatible extra.value constant is consumed without inventing zero', () => {
  const { ir, inst } = fixture({ extra: { value: 37n } }), result = run(ir);
  assert.equal(result.status, 'complete', result.reason);
  assert.equal(value(ir, inst, result).expression.value, 37n);
});
test('constant representations must agree and payload instructions have zero operands', () => {
  const a = fixture({ extra: { value: 37n } }); a.inst.dst.const = 0n;
  assert.equal(run(a.ir).status, 'partial');
  const b = fixture({ value: 5n }); b.inst.args = [{ value: { id: 'unexpected', const: 6n, bits: 8 } }];
  assert.equal(run(b.ir).status, 'partial');
});
test('changing a declared constant payload invalidates the execution snapshot', () => {
  const { ir, inst } = fixture({ extra: { value: 37n } }); inst.dst.const = 37n;
  const result = run(ir); assert.equal(result.status, 'complete', result.reason);
  inst.extra.value = 38n;
  assert.equal(value(ir, inst, result).status, 'unsupported');
});
test('numeric floating payload and unknown floating qualifiers are never integer exact', () => {
  for (const marker of [0, 0.5, 'unknown']) {
    const { ir } = fixture({ value: 0n, extra: { float: marker } });
    assert.equal(run(ir).status, 'partial', String(marker));
  }
  const out = translateMemoryScalar({ op: OP.BIN, sub: 'add', float: 'unknown' }, [createBv(8, 1n), createBv(8, 2n)], 8);
  assert.equal(out.kind, 'unknown_semantic');
});

test('a Bool result cannot silently satisfy an eight-bit SSA carrier',()=>{
  const ir=scalarFixture(),inst=ir.blocks[0].insts[0];inst.op=OP.CMP;inst.cond='eq';
  inst.args.push({value:{id:'zero',bits:8,const:0n}});
  assert.equal(run(ir).status,'partial');
});
test('explicit Bool machine input does not become an exact BV argument',()=>{
  const ir=scalarFixture(),inst=ir.blocks[0].insts[0];
  inst.dst.bits=1;inst.args[0].value.bits=1;inst.args[0].value.machineType={kind:'bool',widthBits:1};
  assert.equal(run(ir).status,'partial');
});
