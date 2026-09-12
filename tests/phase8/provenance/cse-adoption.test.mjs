import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../helpers/ir-fixtures.mjs';
import { identity } from '../helpers/proof-fixtures.mjs';
import { enhanceSemanticDecompilation, optimizeSemanticDecompilation } from '../../../js/decompiler/pipeline.js';
import { evaluateExpression } from '../../../js/decompiler/verify/equivalence.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function checkPrintedC(result, bits, names, values) {
  const type = `uint${bits}_t`, source = ['#include <stdint.h>',
    `static ${type} global_8000, global_8008;`,
    `static void compute(${type} ${names[0]}, ${type} ${names[1]}) {`, result.pseudocode, '}', 'int main(void) {'];
  if (bits === 8) source.push('for (uint32_t a = 0; a < 256; a++) for (uint32_t b = 0; b < 256; b++) {',
    'compute((uint8_t)a, (uint8_t)b); uint8_t expected = (uint8_t)((a ^ b) + (a & b));',
    'if (global_8000 != expected || global_8008 != expected) return 1;', '}');
  else for (const a of values) for (const b of values) {
    const expected = BigInt.asUintN(bits, (a ^ b) + (a & b));
    source.push(`compute((${type})UINT64_C(${a}), (${type})UINT64_C(${b}));`,
      `if (global_8000 != UINT64_C(${expected}) || global_8008 != UINT64_C(${expected})) return 1;`);
  }
  source.push('return 0; }');
  const directory = mkdtempSync(join(tmpdir(), 'hex-cse-printed-')), binary = join(directory, 'check');
  const compiled = spawnSync(process.env.CC || 'cc', ['-std=c11', '-O2', '-fsanitize=undefined',
    '-fno-sanitize-recover=all', '-x', 'c', '-', '-o', binary], { input:source.join('\n'), encoding:'utf8', timeout:30000 });
  assert.equal(compiled.status, 0, compiled.stderr || String(compiled.error));
  const executed = spawnSync(binary, [], { encoding:'utf8', timeout:30000 });
  assert.equal(executed.status, 0, executed.stderr || 'actual printed C changed a stored value');
}

function repeatedFixture(bits = 8, { differentInputs = false, separateBlocks = false, nameCollision = false } = {}) {
  const f = fixture('proved-cse'); f.block(0);
  const a = f.opaque(bits), b = f.opaque(bits);
  a.index = 0; a.reg = 'x0'; b.index = 1; b.reg = 'x1';
  const c = differentInputs ? f.opaque(bits) : b;
  if (differentInputs) { c.index = 2; c.reg = 'x2'; }
  const targets = [];
  const zero = f.constant(0n, bits);
  for (let i = 0; i < 2; i++) {
    const other = i ? c : b;
    const xor = f.binary('xor', a, other, bits), and = f.binary('and', a, other, bits);
    const sum = f.binary('add', xor, and, bits);
    // Both positive and different-input controls must reach actual proof
    // adoption, even if the inner expression is already in extraction order.
    targets.push(f.binary('add', sum, zero, bits));
  }
  f.store(targets[0], { locKind:'global', locKey:'global:32768' });
  if (separateBlocks) { f.branch(1); f.block(1, { pred:[0] }); }
  f.store(targets[1], { locKind:'global', locKey:'global:32776' });
  f.ret();
  const ir = f.build(); ir.instructions = ir.blocks.flatMap(block => block.insts);
  for (const [index, store] of ir.instructions.filter(inst => inst.op === 'store').entries()) {
    store.loc.address = 0x8000n + BigInt(index * 8);
    Object.assign(store.extra.memoryAccess, { volatility:false, atomic:false, ordering:'none', endian:'little' });
  }
  ir.instructions.forEach((inst, index) => { inst.id = index + 100; inst.row = index; inst.address = 0x6000n + BigInt(index * 4); });
  if (separateBlocks) {
    ir.instructions.find(inst => inst.op === 'br').extra = { target:ir.blocks[1].insts[0].address };
    for (const block of ir.blocks) { block.startRow = block.insts[0].row; block.endRow = block.insts.at(-1).row; }
  }
  ir.values.forEach(value => { value.signed = false; });
  const seed = { semantic:true, ir, types:{ values:new Map(), locations:new Map() },
    lines:ir.instructions.filter(inst => ['store', 'ret'].includes(inst.op)).map(inst => ({
      kind:'stmt', indent:1, text:inst.op === 'ret' ? 'return;' : 'old = value;', row:inst.row, addr:inst.address,
    })), warnings:[], evidence:[], coverage:{ mode:'structured' }, summary:'' };
  const result = enhanceSemanticDecompilation(seed, null, { phase8PrepareProof:true, deterministicTransforms:true,
    decompilerTimeBudgetMs:1000, ...(nameCollision ? { argNames:['hex_cse_0', 'a2'] } : {}) });
  return { ir, targets, a, b, result, options:{ identity:{ ...identity, addressSpace:'memory' }, abiId:'generic-v1', memory:{ addressBits:32 },
    targets, timeoutMs:1000, backendTier:'tiered', candidateStrategy:'equality-saturation' } };
}

test('C4-03 proved repeated scalars are actually bound once and reused by both rendered stores', async t => {
 const rows = [];
 for (const bits of [8, 16, 32, 64]) {
  const f = repeatedFixture(bits), before = structuredClone(f.ir), beforeAst = structuredClone(f.result.cAst);
  const result = await optimizeSemanticDecompilation(f.result, f.options);
  assert.equal(result.proofOptimization.status, 'complete', result.proofOptimization.reason);
  assert.ok(result.proofOptimization.adopted >= 2, JSON.stringify(result.proofOptimization.targetDecisions));
  const bindings = result.cAst.body.filter(node => node.semantic?.op === 'cse-binding');
  assert.equal(bindings.length, 1, 'two proved computations must become one actual emitted binding');
  const stores = result.cAst.body.filter(node => node.semantic?.op === 'store');
  assert.equal(stores.length, 2);
  for (const store of stores) {
    assert.equal(store.semantic.expression.kind, 'var');
    assert.equal(store.semantic.expression.name, bindings[0].semantic.name);
  }
  assert.deepEqual(structuredClone(f.ir), before, 'canonical IR and SSA remain intact');
  const record = result.renderProvenance.ledger.find(row => row.kind === 'proved-scalar-cse');
  assert.ok(record, 'actual sharing requires its own provenance event');
  assert.equal(record.producedRefs.length, 3, 'binding and both use statements must navigate to the event');
  assert.equal(result.renderProvenance.completeness, 'complete');
  const inputName = value => f.result.semanticAst.values.find(item => item.valueId === value.id).expression.name;
  const mask = (1n << BigInt(bits)) - 1n;
  const values = bits === 8 ? Array.from({ length:256 }, (_, i) => BigInt(i)) : [0n, 1n, mask, mask >> 1n, 1n << BigInt(bits - 1)];
  for (const a of values) for (const b of values) {
    const expected = ((a ^ b) + (a & b)) & mask;
    const value = evaluateExpression(bindings[0].semantic.expression, { [inputName(f.a)]:a, [inputName(f.b)]:b });
    assert.equal(value, expected);
    for (const store of stores) assert.equal(evaluateExpression(store.semantic.expression, { [bindings[0].semantic.name]:value }), expected);
  }
  checkPrintedC(result, bits, [inputName(f.a), inputName(f.b)], values);
  const replay = await optimizeSemanticDecompilation(result, f.options);
  assert.equal(replay.pseudocode, result.pseudocode, 'replay cannot duplicate the binding');
  assert.deepEqual(replay.renderProvenance, result.renderProvenance);
  assert.deepEqual(structuredClone(f.ir), before);
  assert.deepEqual(structuredClone(f.result.cAst), beforeAst, 'the prepared source projection stays unchanged');
  rows.push({ bits, bindingCount:bindings.length, uses:stores.length, inputPairs:values.length ** 2,
    compiledC:true, provenance:result.renderProvenance.completeness, replay:true });
 }
 t.diagnostic(JSON.stringify({ schema:'c4-proved-cse-adoption-v1', rows, scope:'initial same-block unsigned scalar sharing, not canonical instruction deletion' }));
});

test('C4-03 sharing respects input identity, block boundaries, unique names and proof cancellation', async () => {
  for (const options of [{ differentInputs:true }, { separateBlocks:true }]) {
    const f = repeatedFixture(8, options), result = await optimizeSemanticDecompilation(f.result, f.options);
    assert.equal(result.proofOptimization.status, 'complete', result.proofOptimization.reason);
    assert.ok(result.proofOptimization.adopted >= 2, `negative must reach scalar proof adoption: ${JSON.stringify({ options, decisions:result.proofOptimization.targetDecisions })}`);
    assert.equal(result.cAst.body.some(node => node.semantic?.op === 'cse-binding'), false);
  }
  const collision = repeatedFixture(8, { nameCollision:true });
  const renamed = await optimizeSemanticDecompilation(collision.result, collision.options);
  const binding = renamed.cAst.body.find(node => node.semantic?.op === 'cse-binding');
  assert.ok(binding); assert.equal(binding.semantic.name, 'hex_cse_1');
  const f = repeatedFixture(), controller = new AbortController(); controller.abort();
  const cancelled = await optimizeSemanticDecompilation(f.result, { ...f.options, signal:controller.signal });
  assert.equal(cancelled.proofOptimization.adopted, 0);
  assert.equal(cancelled.cAst, f.result.cAst);
  assert.equal(f.result.cAst.body.some(node => node.semantic?.op === 'cse-binding'), false, 'unproved candidates alone never share computations');
  const exhausted = await optimizeSemanticDecompilation(f.result, { ...f.options, phase8WorkBudget:0 });
  assert.equal(exhausted.proofOptimization.adopted, 0);
  assert.equal(exhausted.cAst, f.result.cAst);
  const copied = { ...f.result, cAst:structuredClone(f.result.cAst) };
  const unbound = await optimizeSemanticDecompilation(copied, f.options);
  assert.equal(unbound.proofOptimization.adopted, 0);
  assert.equal(unbound.cAst, copied.cAst);
  f.targets[0].def.sub = 'sub';
  const stale = await optimizeSemanticDecompilation(f.result, f.options);
  assert.equal(stale.proofOptimization.adopted, 0);
  assert.equal(stale.cAst, f.result.cAst);
});
