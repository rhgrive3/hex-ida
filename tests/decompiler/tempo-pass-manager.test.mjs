import test from 'node:test';
import assert from 'node:assert/strict';

import { PassManager } from '../../js/decompiler/passes/manager.js';
import { captureProjectionData } from '../../js/decompiler/phase8/projection-origin.js';
import {
  INTERACTIVE_STAGES,
  PASS_STAGES,
  phase8Passes,
  passRegistryDigest,
  runPhase8Stage,
} from '../../js/decompiler/phase8/index.js';
import { buildExpressionForTesting } from '../../js/decompiler/pipeline-core.js';

test('PassManager readOnlyKeys skips deep snapshot of immutable roots while still rolling back top-level reassignment', () => {
  let getterCalls = 0;
  const heavyRoot = Object.freeze({
    nested: {
      value: 42,
    },
  });
  const trackedObj = { a: 1 };
  const priorPassOutput = { items: [1, 2, 3] };

  const state = {
    heavyRoot,
    priorPassOutput,
    mutableWork: trackedObj,
    // Verify readOnlyKeys reads own data descriptors without invoking accessors on skipped roots.
    get lazyCheck() {
      getterCalls += 1;
      return null;
    },
  };

  const manager = new PassManager([
    {
      name: 'failing-pass',
      readOnlyKeys: ['priorPassOutput'],
      run(s) {
        s.heavyRoot = { replaced: true };
        s.priorPassOutput = { replaced: true };
        s.mutableWork.a = 999;
        throw new Error('boom');
      },
    },
  ], {
    readOnlyKeys: ['heavyRoot'],
  });

  const out = manager.run(state);
  assert.equal(out.heavyRoot, heavyRoot, 'top-level reassignment of readOnlyKeys root must roll back');
  assert.equal(out.priorPassOutput, priorPassOutput, 'top-level reassignment of pass readOnlyKeys root must roll back');
  assert.equal(out.mutableWork.a, 1, 'mutable pass-owned data must roll back');
  assert.equal(getterCalls, 0, 'unrelated accessors are not invoked by readOnlyKeys');
});

test('PassManager rolls back mutable descendant inside frozen wrapper without double-enumerating frozen keys', () => {
  const mutableLeaf = { count: 1 };
  const frozenWrapper = Object.freeze({
    leaf: mutableLeaf,
    deepImmutable: Object.freeze({ tag: 'const', arr: Object.freeze([1, 2, 3]) }),
  });
  const state = { wrapper: frozenWrapper };

  const manager = new PassManager([
    {
      name: 'mutate-leaf-and-fail',
      run(s) {
        s.wrapper.leaf.count = 77;
        throw new Error('rollback-me');
      },
    },
  ]);

  const out = manager.run(state);
  assert.equal(out.wrapper, frozenWrapper);
  assert.equal(out.wrapper.leaf.count, 1);
});

test('captureProjectionData caches frozen objects and still detects mutations on mutable objects', () => {
  const frozenSubtree = Object.freeze({
    kind: 'const',
    value: 123n,
    meta: Object.freeze({ bits: 64 }),
  });
  const mutableContainer = {
    tag: 'root',
    child: frozenSubtree,
  };
  const snapshot = captureProjectionData([mutableContainer, frozenSubtree]);
  assert.equal(snapshot.matches(), true);
  assert.equal(snapshot.matches(), true);
  assert.equal(snapshot.tokenOf(frozenSubtree) != null, true);

  mutableContainer.tag = 'mutated';
  assert.equal(snapshot.matches(), false);

  mutableContainer.tag = 'root';
  assert.equal(snapshot.matches(), true);
  Object.freeze(mutableContainer);
  assert.equal(snapshot.matches(), true);
  assert.equal(snapshot.matches(), true);
});

test('Phase 8 caches static pass lists and registry digests and samples clock while honoring entry/exit deadlines', () => {
  const interactiveA = phase8Passes({ stages: INTERACTIVE_STAGES });
  const interactiveB = phase8Passes({ stages: INTERACTIVE_STAGES });
  assert.equal(interactiveA, interactiveB, 'interactive pass list should be cached');

  const allA = phase8Passes({ stages: PASS_STAGES });
  const allB = phase8Passes({ stages: PASS_STAGES });
  assert.equal(allA, allB, 'full pass list should be cached');

  assert.equal(passRegistryDigest(interactiveA), passRegistryDigest(interactiveB));
  assert.equal(passRegistryDigest(allA), passRegistryDigest(allB));

  // Entry deadline check fails closed immediately when timeBudgetMs is 0 and clock advances.
  let clockReads = 0;
  const baseIr = {
    blocks: [{ index: 0, startRow: 0, endRow: 0, insts: [], phis: [], succ: [], pred: [] }],
    instructions: [],
    values: [],
    args: new Map(),
    entry: 0,
  };
  const immediateCancel = runPhase8Stage(
    { ir: baseIr, opts: {} },
    {
      stages: INTERACTIVE_STAGES,
      timeBudgetMs: 0,
      clock: () => {
        clockReads += 1;
        return clockReads === 1 ? 100 : 101;
      },
    },
  );
  assert.equal(immediateCancel.ledger.published, false);
  assert.equal(immediateCancel.budget.deadlineExceeded, true);

  // Interactive read-only stage publishes cleanly without needing an analysis fork.
  const published = runPhase8Stage(
    { ir: baseIr, opts: {} },
    { stages: INTERACTIVE_STAGES },
  );
  assert.equal(published.ledger.published, true);
  assert.ok(published.ledger.completeness === 'complete' || published.ledger.completeness === 'unknown');
  assert.ok(published.analysis);
});

test('pipeline-core abiArgumentLocationForRegister and argumentName use O(1) indexed lookups', () => {
  let adapterCalls = 0;
  const abiAdapter = {
    argumentLocations() {
      adapterCalls += 1;
      return [
        { index: 0, reg: 'x0' },
        { index: 1, reg: 'x1' },
        { index: 2, reg: 'x2' },
      ];
    },
  };
  const state = {
    ir: { values: [], blocks: [], instructions: [] },
    opts: { abiAdapter },
    highVariables: {
      valueToGroup: new Map([[10, 'g1']]),
      groups: [{ id: 'g1', name: 'named_arg' }, { id: 'g2', name: 'other_arg' }],
    },
  };

  const arg0 = { id: 1, kind: 'arg', reg: 'x0', bits: 64 };
  const arg1 = { id: 2, kind: 'arg', reg: 'x1', bits: 64 };
  const arg2 = { id: 3, kind: 'arg', reg: 'x2', bits: 64 };
  const argNamed = { id: 10, kind: 'arg', reg: 'x0', bits: 64 };
  const sum01 = { id: 4, bits: 64, def: { op: 'bin', sub: 'add', args: [{ value: arg0 }, { value: arg1 }] } };
  const sumAll = { id: 5, bits: 64, def: { op: 'bin', sub: 'add', args: [{ value: sum01 }, { value: arg2 }] } };
  const root = { id: 6, bits: 64, def: { op: 'bin', sub: 'add', args: [{ value: sumAll }, { value: argNamed }] } };
  const built = buildExpressionForTesting(root, state);
  assert.equal(built.left.left.left.name, 'a1');
  assert.equal(built.left.left.right.name, 'a2');
  assert.equal(built.left.right.name, 'a3');
  assert.equal(built.right.name, 'named_arg');
  assert.equal(adapterCalls, 1, 'ABI argumentLocations should be queried once per (state, adapter, prototype)');
});

import { createSemanticCfg, isCanonicalSemanticCfg } from '../../js/semantics/cfg/index.js';
import { validateMemorySsa } from '../../js/semantics/memoryssa/validate.js';
import { MEMORY_SSA_CONTRACT_VERSION } from '../../js/semantics/memoryssa/contract.js';

test('Review fixes: runPhase8Stage checks custom clock every step without &63 stride', () => {
  let reads = 0;
  const baseIr = {
    blocks: [{ index: 0, startRow: 0, endRow: 0, insts: [], phis: [], succ: [], pred: [] }],
    instructions: [],
    values: [],
    args: new Map(),
    entry: 0,
  };
  const outcome = runPhase8Stage(
    { ir: baseIr, opts: {} },
    {
      stages: INTERACTIVE_STAGES,
      timeBudgetMs: 10,
      clock: () => {
        reads += 1;
        // First read is started=100; second read is 105 (within budget); third read exceeds deadline=110.
        if (reads === 1) return 100;
        if (reads === 2) return 105;
        return 120;
      },
    },
  );
  assert.equal(outcome.ledger.published, false);
  assert.equal(outcome.budget.deadlineExceeded, true);
  assert.ok(reads >= 3, 'custom clock must be consulted on subsequent work checks without waiting for 64 checks');
});

test('Review fixes: isCanonicalSemanticCfg gates validateMemorySsa CFG cache against shallow-frozen CFGs', () => {
  const canonicalCfg = createSemanticCfg({
    functionId: 'fn_cfg_cache',
    entryBlockId: 'b0',
    blocks: [{ id: 'b0', successors: [] }],
  });
  assert.equal(isCanonicalSemanticCfg(canonicalCfg), true);

  const mutableBlocks = [{ id: 'b0', successors: [] }];
  const shallowFrozenCfg = Object.freeze({
    functionId: 'fn_cfg_cache',
    entryBlockId: 'b0',
    blocks: mutableBlocks,
  });
  assert.equal(isCanonicalSemanticCfg(shallowFrozenCfg), false);

  const memorySsa = validateMemorySsa({
    contractVersion: MEMORY_SSA_CONTRACT_VERSION,
    functionId: 'fn_cfg_cache',
    regions: [{ id: 'r0', kind: 'stack-fixed', functionId: 'fn_cfg_cache', offset: '-8', origin: { addresses: ['0x1000'] } }],
    definitions: [{ id: 'd0', regionId: 'r0', blockId: 'b0', kind: 'entry', origin: { addresses: ['0x1000'] } }],
    uses: [],
    blockStates: [{
      blockId: 'b0',
      entry: [{ regionId: 'r0', definitionId: 'd0' }],
      exit: [{ regionId: 'r0', definitionId: 'd0' }],
    }],
  }, { cfg: shallowFrozenCfg });

  // Mutating the nested blocks array of the shallow-frozen CFG must be observed on re-validation.
  mutableBlocks.length = 0;
  assert.throws(
    () => validateMemorySsa(memorySsa, { cfg: shallowFrozenCfg }),
    /memory-ssa-invalid-definition-block/,
  );

  // Canonical CFG remains cacheable and valid for trusted frozen artifacts.
  const baseValidated = validateMemorySsa(memorySsa);
  validateMemorySsa(baseValidated, { cfg: canonicalCfg });
  assert.equal(validateMemorySsa(baseValidated, { cfg: canonicalCfg }), baseValidated);
});
