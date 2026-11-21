import test from 'node:test';
import assert from 'node:assert/strict';
import { deepFreeze } from '../../../js/core/identity/index.js';
import { canonicalAnalysisIdentity } from '../../../js/decompiler/phase8/analysis-identity.js';

function makeIrWithForwarding(loadCount, makeCtx, makeExtraCtx = makeCtx) {
  const insts = [];
  const values = [];
  for (let i = 0; i < loadCount; i += 1) {
    const val = { id: i + 1, bits: 64, kind: 'tmp' };
    const ctx = makeCtx(i);
    const extraCtx = makeExtraCtx(i);
    const inst = {
      id: `ld_${i}`,
      op: 'load',
      block: 0,
      row: i,
      dst: val,
      args: [],
      memoryForwardingContext: ctx,
      extra: {
        semanticNodeId: `n_${i}`,
        memoryForwardingContext: extraCtx,
      },
    };
    val.def = inst;
    insts.push(inst);
    values.push(val);
  }
  return {
    functionId: 'fn_forwarding_test',
    entry: 0,
    blocks: [{ index: 0, id: 'b0', succ: [], pred: [], insts, phis: [], memPhis: [] }],
    values,
    instructions: insts,
  };
}

test('shared deep-frozen memoryForwardingContext.artifact is hashed once across many loads', () => {
  const bigArtifact = deepFreeze({
    contractVersion: 1,
    functionId: 'fn_forwarding_test',
    canonicalDigest: 'a'.repeat(32),
    byteCoverage: Array.from({ length: 400 }, (_, i) => ({
      useId: `u_${i}`,
      regionId: `r_${i % 20}`,
      payload: `coverage-row-${i}-`.repeat(8),
    })),
  });
  const ir = makeIrWithForwarding(80, (i) => ({
    artifact: bigArtifact,
    artifactDigest: bigArtifact.canonicalDigest,
    snapshotId: 'snap_1',
    useId: `u_${i}`,
    nodeId: `n_${i}`,
  }));

  const t0 = performance.now();
  const first = canonicalAnalysisIdentity({ ir });
  const firstMs = performance.now() - t0;
  assert.equal(first.valid, true);
  assert.ok(first.identity.semanticIrId.startsWith('semantic-ir:'));

  const t1 = performance.now();
  const second = canonicalAnalysisIdentity({ ir });
  const secondMs = performance.now() - t1;
  assert.equal(second.valid, true);
  assert.deepEqual(second.identity, first.identity);
  assert.ok(firstMs < 5000, `expected fast first identity, got ${firstMs.toFixed(1)}ms`);
  assert.ok(secondMs < 5000, `expected fast repeat identity, got ${secondMs.toFixed(1)}ms`);
});

test('mutating memoryForwardingContext fields or swapping artifact invalidates canonicalAnalysisIdentity', () => {
  const artA = deepFreeze({ tag: 'A', rows: [1, 2, 3] });
  const artB = deepFreeze({ tag: 'B', rows: [1, 2, 4] });
  const ir = makeIrWithForwarding(4, (i) => ({
    artifact: artA,
    snapshotId: 'snap_1',
    useId: `u_${i}`,
  }));
  const base = canonicalAnalysisIdentity({ ir });
  assert.equal(base.valid, true);

  // Mutate snapshotId on top-level memoryForwardingContext only
  ir.instructions[2].memoryForwardingContext.snapshotId = 'snap_stale';
  const afterSnap = canonicalAnalysisIdentity({ ir });
  assert.equal(afterSnap.valid, true);
  assert.notEqual(afterSnap.identity.semanticIrId, base.identity.semanticIrId);
  ir.instructions[2].memoryForwardingContext.snapshotId = 'snap_1';

  // Mutate extra.memoryForwardingContext only
  ir.instructions[1].extra.memoryForwardingContext.snapshotId = 'snap_extra_stale';
  const afterExtraSnap = canonicalAnalysisIdentity({ ir });
  assert.equal(afterExtraSnap.valid, true);
  assert.notEqual(afterExtraSnap.identity.semanticIrId, base.identity.semanticIrId);
  ir.instructions[1].extra.memoryForwardingContext.snapshotId = 'snap_1';

  // Swap artifact on a single load
  ir.instructions[0].memoryForwardingContext.artifact = artB;
  const afterArtSwap = canonicalAnalysisIdentity({ ir });
  assert.equal(afterArtSwap.valid, true);
  assert.notEqual(afterArtSwap.identity.semanticIrId, base.identity.semanticIrId);
});

test('shallow-frozen artifact detects in-place descendant mutation and resists tag spoofing', () => {
  const mutableChild = { version: 1 };
  const shallowArt = Object.freeze({ nested: mutableChild });
  const ir = makeIrWithForwarding(2, (i) => ({
    artifact: shallowArt,
    snapshotId: 'snap_1',
    useId: `u_${i}`,
  }));
  const before = canonicalAnalysisIdentity({ ir });
  assert.equal(before.valid, true);

  mutableChild.version = 2;
  const after = canonicalAnalysisIdentity({ ir });
  assert.equal(after.valid, true);
  assert.notEqual(after.identity.semanticIrId, before.identity.semanticIrId);

  // Spoofed raw object shaped like internal envelope cannot collide with real frozen artifact
  const realArt = deepFreeze({ ok: true });
  const irReal = makeIrWithForwarding(1, () => ({ artifact: realArt, useId: 'u_0' }));
  const realId = canonicalAnalysisIdentity({ ir: irReal });
  const irSpoof = makeIrWithForwarding(1, () => ({
    kind: 'forwarding-context-ref',
    fields: { useId: 'u_0' },
    artifactDigest: '0'.repeat(32),
  }));
  const spoofId = canonicalAnalysisIdentity({ ir: irSpoof });
  assert.equal(realId.valid, true);
  assert.equal(spoofId.valid, true);
  assert.notEqual(realId.identity.semanticIrId, spoofId.identity.semanticIrId);
});

test('accessor, non-enumerable, or cyclic memoryForwardingContext/artifact fails closed without invoking getters', () => {
  let getterCalls = 0;
  const ctxWithGetter = {};
  Object.defineProperty(ctxWithGetter, 'artifact', {
    enumerable: true,
    get() { getterCalls += 1; return {}; },
  });
  const irGetter = makeIrWithForwarding(1, () => ctxWithGetter);
  assert.equal(canonicalAnalysisIdentity({ ir: irGetter }).valid, false);
  assert.equal(getterCalls, 0);

  const irCyclic = makeIrWithForwarding(1, () => ({}));
  irCyclic.instructions[0].memoryForwardingContext.artifact = irCyclic.instructions[0];
  assert.equal(canonicalAnalysisIdentity({ ir: irCyclic }).valid, false);

  // Accessor on memoryForwardingContext itself fails closed without invocation
  let ctxGetterCalls = 0;
  const irCtxGetter = makeIrWithForwarding(1, () => ({}));
  Object.defineProperty(irCtxGetter.instructions[0], "memoryForwardingContext", {
    enumerable: true,
    configurable: true,
    get() { ctxGetterCalls += 1; return {}; },
  });
  assert.equal(canonicalAnalysisIdentity({ ir: irCtxGetter }).valid, false);
  assert.equal(ctxGetterCalls, 0);

  // Non-enumerable memoryForwardingContext and non-enumerable artifact fail closed
  const irNonEnumCtx = makeIrWithForwarding(1, () => ({}));
  Object.defineProperty(irNonEnumCtx.instructions[0], "memoryForwardingContext", {
    enumerable: false,
    configurable: true,
    value: { artifact: deepFreeze({ ok: true }), useId: "u_0" },
  });
  assert.equal(canonicalAnalysisIdentity({ ir: irNonEnumCtx }).valid, false);

  const nonEnumArtCtx = { useId: "u_0" };
  Object.defineProperty(nonEnumArtCtx, "artifact", {
    enumerable: false,
    configurable: true,
    value: deepFreeze({ ok: true }),
  });
  const irNonEnumArt = makeIrWithForwarding(1, () => nonEnumArtCtx);
  assert.equal(canonicalAnalysisIdentity({ ir: irNonEnumArt }).valid, false);

  // Cycle in ctx alongside a deep-frozen artifact (exercises fast-path cycle guard)
  const frozenArt = deepFreeze({ kind: "memoryssa", version: 1 });
  const cyclicFastCtx = { artifact: frozenArt, useId: "u_0" };
  cyclicFastCtx.self = cyclicFastCtx;
  const irCyclicFast = makeIrWithForwarding(1, () => cyclicFastCtx);
  assert.equal(canonicalAnalysisIdentity({ ir: irCyclicFast }).valid, false);
});
