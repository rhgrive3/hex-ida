import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../phase8/helpers/ir-fixtures.mjs';
import { identity } from '../phase8/helpers/proof-fixtures.mjs';
import { enhanceSemanticDecompilation, optimizeSemanticDecompilation } from '../../js/decompiler/pipeline.js';

function repeatedStoreFixture(count = 96) {
  const f = fixture('proved-cse-indexing');
  f.block(0);
  const a = f.opaque(32), b = f.opaque(32);
  a.index = 0; a.reg = 'x0'; b.index = 1; b.reg = 'x1';
  const zero = f.constant(0n, 32);
  const xor = f.binary('xor', a, b, 32), and = f.binary('and', a, b, 32);
  const sum = f.binary('add', xor, and, 32);
  const target = f.binary('add', sum, zero, 32);
  for (let index = 0; index < count; index++) {
    f.store(target, { locKind:'global', locKey:`global:${0x8000 + index * 8}` });
  }
  f.ret();
  const ir = f.build();
  ir.instructions = ir.blocks.flatMap((block) => block.insts);
  for (const [index, store] of ir.instructions.filter((inst) => inst.op === 'store').entries()) {
    store.loc.address = 0x8000n + BigInt(index * 8);
    Object.assign(store.extra.memoryAccess, { volatility:false, atomic:false, ordering:'none', endian:'little' });
  }
  ir.instructions.forEach((inst, index) => {
    inst.id = index + 100;
    inst.row = index;
    inst.address = 0x6000n + BigInt(index * 4);
  });
  ir.values.forEach((value) => { value.signed = false; });
  const seed = {
    semantic:true, ir, types:{ values:new Map(), locations:new Map() },
    lines:ir.instructions.filter((inst) => ['store', 'ret'].includes(inst.op)).map((inst) => ({
      kind:'stmt', indent:1, text:inst.op === 'ret' ? 'return;' : 'old = value;', row:inst.row, addr:inst.address,
    })),
    warnings:[], evidence:[], coverage:{ mode:'structured' }, summary:'',
  };
  const result = enhanceSemanticDecompilation(seed, null, {
    phase8PrepareProof:true, deterministicTransforms:true, decompilerTimeBudgetMs:5000,
  });
  return {
    ir, result,
    options:{ identity:{ ...identity, addressSpace:'memory' }, abiId:'generic-v1', memory:{ addressBits:32 },
      targets:[target], timeoutMs:5000, backendTier:'tiered', candidateStrategy:'equality-saturation' },
  };
}

test('proved-scalar CSE checks canonical instruction order without repeated full-array indexOf scans', async () => {
  const f = repeatedStoreFixture();
  const originalIndexOf = Array.prototype.indexOf;
  let instructionIndexScans = 0;
  Array.prototype.indexOf = function patchedIndexOf(...args) {
    if (this === f.ir.instructions) instructionIndexScans += 1;
    return Reflect.apply(originalIndexOf, this, args);
  };
  let result;
  try { result = await optimizeSemanticDecompilation(f.result, f.options); }
  finally { Array.prototype.indexOf = originalIndexOf; }
  assert.equal(result.proofOptimization.status, 'complete', result.proofOptimization.reason);
  assert.ok(result.cAst.body.some((node) => node.semantic?.op === 'cse-binding'), 'fixture must reach actual CSE insertion');
  assert.ok(instructionIndexScans <= 4, `CSE order check performed ${instructionIndexScans} instruction-array indexOf scans`);
});
