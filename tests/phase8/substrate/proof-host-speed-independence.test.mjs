import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from '../helpers/ir-fixtures.mjs';
import { identity } from '../helpers/proof-fixtures.mjs';
import { enhanceSemanticDecompilation, optimizeSemanticDecompilation } from '../../../js/decompiler/pipeline.js';

function createBitfieldFixture(bits = 8, mode = 'bfi') {
  const f = fixture('proof-bitfield');
  f.block(0);
  const a = f.opaque(bits), b = f.opaque(bits);
  a.index = 0; a.reg = 'x0'; b.index = 1; b.reg = 'x1';
  const zero = f.binary('xor', a, a, bits), source = f.binary('add', a, zero, bits);
  const lsb = bits === 1 ? 0 : 1, width = Math.max(1, Math.floor(bits / 2));
  const target = f.binary('insert', b, source, bits);
  target.def.op = 'bfi';
  target.def.extra = { lsb, width, bitfieldKind: mode };
  f.ret();
  const ir = f.build();
  ir.instructions = ir.blocks.flatMap(block => block.insts);
  ir.instructions.forEach((inst, index) => { inst.id = 'field_' + index; inst.address = 0x6000n + BigInt(index * 4); });
  const ret = ir.instructions.at(-1);
  ret.args = [{ value: target }];
  target.uses.push(ret);
  const canonical = structuredClone(ir);
  const result = enhanceSemanticDecompilation({
    semantic: true, ir, types: null,
    lines: ir.instructions.filter(inst => ['ret', 'store'].includes(inst.op)).map(inst => ({
      kind: 'stmt', indent: 0, text: 'return pending;', row: inst.row, addr: inst.address
    })), metrics: {}, ctx: {}
  }, null, {
    profile: 'deep', phase8PrepareProof: true, phase8ProofOnlyRewrites: true,
    deterministicTransforms: true, decompilerTimeBudgetMs: 1000
  });
  return {
    ir, a, b, source, target, lsb, width, canonical, result,
    options: {
      identity, abiId: 'generic-v1', memory: { addressBits: 8 }, targets: [target],
      timeoutMs: 1000, backendTier: 'tiered', requireProofOnlyRewrites: true,
      candidateStrategy: 'local-rewrites'
    }
  };
}

test('symbolic proof path produces identical status and adopted count under artificial slow clock', async () => {
  const f = createBitfieldFixture(8, 'bfi');

  // Baseline run with standard monotonic clock
  const baseline = await optimizeSemanticDecompilation(f.result, f.options);
  assert.equal(baseline.proofOptimization.status, 'complete');
  assert.equal(baseline.proofOptimization.adopted, 1);
  assert.equal(baseline.proofOptimization.targetDecisions[0].disposition, 'adopted');

  // Run with artificially accelerated clock (simulating a 1000x slower host)
  let simulatedTime = 0;
  const slowHostClock = () => {
    simulatedTime += 500; // Each clock sample advances by 500ms
    return simulatedTime;
  };
  const slowHostRun = await optimizeSemanticDecompilation(f.result, {
    ...f.options,
    now: slowHostClock
  });

  // Host-speed independence: output must be identical regardless of clock rate
  assert.equal(slowHostRun.proofOptimization.status, baseline.proofOptimization.status);
  assert.equal(slowHostRun.proofOptimization.adopted, baseline.proofOptimization.adopted);
  assert.equal(slowHostRun.proofOptimization.targetDecisions[0].disposition, baseline.proofOptimization.targetDecisions[0].disposition);
  assert.equal(slowHostRun.proofOptimization.targetDecisions[0].queryHash, baseline.proofOptimization.targetDecisions[0].queryHash);
  assert.equal(slowHostRun.proofOptimization.planId, baseline.proofOptimization.planId);
});
