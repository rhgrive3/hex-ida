import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSemanticModel } from '../js/blocks.js';
import { summarizeFunction, createFunctionSummaryCache } from '../js/interproc.js';
import { restoreLegacyPrivateStackForwarding } from '../js/legacy-stack-compat-repair.js';
import { analyzeGraph } from '../js/controlflow.js';
import { OP, VK } from '../js/ir.js';
import { FACT, canonicalThresholdComparison, proveClampSelect, semanticFacts } from '../js/semantic.js';
import { findSink } from '../js/comprehend.js';
import { TypeStore, structToC } from '../js/types-legacy.js';

const BASE = 0x100000000n;
const CALLEE = 0x100001000n;

function modelAt(base, lines) {
  const rows = lines.map((line, i) => {
    const text = line.trim();
    const space = text.indexOf(' ');
    return {
      row: i,
      address: base + BigInt(i * 4),
      mn: space < 0 ? text : text.slice(0, space),
      ops: space < 0 ? '' : text.slice(space + 1),
    };
  });
  return buildSemanticModel(rows, {
    startRow: 0,
    endRow: rows.length - 1,
    rowOfAddress(address) {
      const delta = address - base;
      if (delta < 0n || delta >= BigInt(rows.length * 4)) return null;
      return Number(delta / 4n);
    },
  });
}

test('Bug 1 (P1): interproc does not classify non-forwarding single-call functions as forwarding or overwrite their return summary', async () => {
  const callee = modelAt(CALLEE, [
    'mov x0, #99',
    'ret',
  ]);

  // Calls callee, ignores its return value, and returns constant 7.
  const constCaller = modelAt(BASE, [
    `bl #0x${CALLEE.toString(16)}`,
    'mov x0, #7',
    'ret',
  ]);
  const constSummary = summarizeFunction(constCaller, {
    returnEvidence: { trusted: true, source: 'prototype' },
  });
  assert.equal(constSummary.classification.forwarding, false);
  assert.equal(constSummary.returns[0].kind, 'constant');
  assert.equal(constSummary.returns[0].value, 7n);

  const cache1 = createFunctionSummaryCache({
    program: { functionRange: () => null },
    analyze: async (address) => address === BASE ? constCaller : address === CALLEE ? callee : null,
    returnEvidenceFor: async () => ({ trusted: true, source: 'prototype' }),
  }, { maxDepth: 2 });
  const resolvedConst = await cache1.summaryFor(BASE);
  assert.equal(resolvedConst.classification.forwarding, false);
  assert.equal(resolvedConst.propagatedReturn, undefined);
  assert.equal(resolvedConst.returns.length, 1);
  assert.equal(resolvedConst.returns[0].kind, 'constant');
  assert.equal(resolvedConst.returns[0].value, 7n);

  // Calls callee, ignores its return value, and returns argument x19 (saved from x1).
  const argCaller = modelAt(BASE, [
    'mov x19, x1',
    `bl #0x${CALLEE.toString(16)}`,
    'mov x0, x19',
    'ret',
  ]);
  const cache2 = createFunctionSummaryCache({
    program: { functionRange: () => null },
    analyze: async (address) => address === BASE ? argCaller : address === CALLEE ? callee : null,
    returnEvidenceFor: async () => ({ trusted: true, source: 'prototype' }),
  }, { maxDepth: 2 });
  const resolvedArg = await cache2.summaryFor(BASE);
  assert.equal(resolvedArg.classification.forwarding, false);
  assert.equal(resolvedArg.propagatedReturn, undefined);
  assert.equal(resolvedArg.returns[0].kind, 'argument');
  assert.equal(resolvedArg.returns[0].index, 1);

  // Positive control: genuine forwarding wrapper still propagates callee return value.
  const trueForwarder = modelAt(BASE, [
    `bl #0x${CALLEE.toString(16)}`,
    'ret',
  ]);
  const cache3 = createFunctionSummaryCache({
    program: { functionRange: () => null },
    analyze: async (address) => address === BASE ? trueForwarder : address === CALLEE ? callee : null,
    returnEvidenceFor: async () => ({ trusted: true, source: 'prototype' }),
  }, { maxDepth: 2 });
  const resolvedForwarder = await cache3.summaryFor(BASE);
  assert.equal(resolvedForwarder.classification.forwarding, true);
  assert.equal(resolvedForwarder.propagatedReturn?.kind, 'constant');
  assert.equal(resolvedForwarder.propagatedReturn?.value, 99n);
  assert.equal(resolvedForwarder.returns[0].value, 99n);
});

test('Bug 2 (P1): legacy-stack-compat-repair kills forwarding across partially overlapping or different-size stack stores', () => {
  function runScenario(interveningStore) {
    const val0 = { id: 1, kind: 'arg', reg: 'x0', bits: 64 };
    const val1 = { id: 2, kind: 'arg', reg: 'x1', bits: 32 };
    const oldStore = {
      id: 10,
      op: 'store',
      block: 0,
      row: 1,
      size: 8,
      loc: { kind: 'stack', key: 'stack:16', disp: 16n, size: 8 },
      addr: { disp: 16n, size: 8 },
      args: [{ value: val0, bits: 64 }],
      memDef: { kind: 'def', instId: 10 },
    };
    const callInst = {
      id: 20,
      op: 'call',
      block: 0,
      row: 3,
      args: [],
      memKills: [{ kind: 'stack', key: 'stack:16' }],
    };
    const loadInst = {
      id: 30,
      op: 'load',
      block: 0,
      row: 4,
      size: 8,
      loc: { kind: 'stack', key: 'stack:16', disp: 16n, size: 8 },
      addr: { disp: 16n, size: 8 },
      args: [],
      reachingStore: null,
      memUse: { kind: 'clobber', inst: callInst },
    };

    const insts = [oldStore, interveningStore, callInst, loadInst].filter(Boolean);
    const projected = {
      blocks: [{ id: 0, pred: [], succ: [], insts }],
      instructions: insts,
      values: [val0, val1],
      dominators: [new Set([0])],
    };

    restoreLegacyPrivateStackForwarding(projected, () => null);
    return { oldStore, loadInst };
  }

  // Case A: Partial overlap on upper half [20, 24) kills [16, 24).
  {
    const { loadInst } = runScenario({
      id: 15,
      op: 'store',
      block: 0,
      row: 2,
      size: 4,
      loc: { kind: 'stack', key: 'stack:20', disp: 20n, size: 4 },
      addr: { disp: 20n, size: 4 },
      args: [{ value: { id: 2, kind: 'arg', reg: 'x1', bits: 32 }, bits: 32 }],
      memDef: { kind: 'def', instId: 15 },
    });
    assert.equal(loadInst.reachingStore, null, 'partial upper overlap must kill forwarding');
  }

  // Case B: Same offset, smaller size [16, 20) kills [16, 24).
  {
    const { loadInst } = runScenario({
      id: 16,
      op: 'store',
      block: 0,
      row: 2,
      size: 4,
      loc: { kind: 'stack', key: 'stack:16', disp: 16n, size: 4 },
      addr: { disp: 16n, size: 4 },
      args: [{ value: { id: 2, kind: 'arg', reg: 'x1', bits: 32 }, bits: 32 }],
      memDef: { kind: 'def', instId: 16 },
    });
    assert.equal(loadInst.reachingStore, null, 'same-key different-size overwrite must kill forwarding');
  }

  // Case C: Partial overlap on lower half [12, 20) kills [16, 24).
  {
    const { loadInst } = runScenario({
      id: 17,
      op: 'store',
      block: 0,
      row: 2,
      size: 8,
      loc: { kind: 'stack', key: 'stack:12', disp: 12n, size: 8 },
      addr: { disp: 12n, size: 8 },
      args: [{ value: { id: 2, kind: 'arg', reg: 'x1', bits: 64 }, bits: 64 }],
      memDef: { kind: 'def', instId: 17 },
    });
    assert.equal(loadInst.reachingStore, null, 'partial lower overlap must kill forwarding');
  }

  // Case D: Strictly disjoint stack store [32, 40) does NOT kill [16, 24).
  {
    const { oldStore, loadInst } = runScenario({
      id: 18,
      op: 'store',
      block: 0,
      row: 2,
      size: 8,
      loc: { kind: 'stack', key: 'stack:32', disp: 32n, size: 8 },
      addr: { disp: 32n, size: 8 },
      args: [{ value: { id: 2, kind: 'arg', reg: 'x1', bits: 64 }, bits: 64 }],
      memDef: { kind: 'def', instId: 18 },
    });
    assert.equal(loadInst.reachingStore, oldStore, 'disjoint stack store must not block forwarding');
  }
});

test('Bug 3 (P1): semantic.js rejects tst, cmn, and ccmp as subtraction threshold comparisons', () => {
  let nextId = 1;
  const mkVal = (name, constant = null) => ({
    id: nextId++,
    reg: name,
    bits: 32,
    kind: constant == null ? VK.DEF : VK.CONST,
    const: constant,
    signed: null,
    def: null,
    uses: [],
  });

  function runBranchFacts(cmpSpec, cond = 'eq') {
    const x = mkVal('x0');
    const c = mkVal(null, 8n);
    const flags = mkVal('nzcv');
    const cmpInst = {
      id: nextId++,
      op: OP.CMP,
      sub: cmpSpec.sub,
      conditional: cmpSpec.conditional,
      extra: cmpSpec.extra,
      row: 1,
      address: 0x1000n,
      args: [{ value: x }, { value: c }],
      dst: flags,
    };
    flags.def = cmpInst;
    const branch = {
      id: nextId++,
      op: OP.CBR,
      cond,
      row: 2,
      address: 0x1004n,
      args: [{ value: flags }],
      extra: { target: 0x1020n },
    };
    const facts = semanticFacts({ instructions: [cmpInst, branch], values: [x, c, flags] });
    return { cmpInst, x, c, facts };
  }

  // tst (sub: 'and') must emit BRANCH, never THRESHOLD or ZERO_NULL.
  {
    const { cmpInst, x, c, facts } = runBranchFacts({ sub: 'and' }, 'ne');
    assert.equal(facts.filter((f) => f.kind === FACT.BRANCH).length, 1);
    assert.equal(facts.filter((f) => f.kind === FACT.THRESHOLD).length, 0);
    assert.equal(facts.filter((f) => f.kind === FACT.ZERO_NULL).length, 0);
    assert.equal(canonicalThresholdComparison({ cmp: cmpInst, value: x, other: c, cond: 'ne' }), null);
  }

  // cmn (sub: 'add') must emit BRANCH, never THRESHOLD.
  {
    const { cmpInst, x, c, facts } = runBranchFacts({ sub: 'add' }, 'eq');
    assert.equal(facts.filter((f) => f.kind === FACT.BRANCH).length, 1);
    assert.equal(facts.filter((f) => f.kind === FACT.THRESHOLD).length, 0);
    assert.equal(canonicalThresholdComparison({ cmp: cmpInst, value: x, other: c, cond: 'eq' }), null);
  }

  // ccmp (conditional: true on instruction) must emit BRANCH, never THRESHOLD.
  {
    const { cmpInst, x, c, facts } = runBranchFacts({ sub: 'sub', conditional: true }, 'lt');
    assert.equal(facts.filter((f) => f.kind === FACT.BRANCH).length, 1);
    assert.equal(facts.filter((f) => f.kind === FACT.THRESHOLD).length, 0);
    assert.equal(canonicalThresholdComparison({ cmp: cmpInst, value: x, other: c, cond: 'lt' }), null);
  }

  // ccmp (extra.conditional: true as produced by semantic-ir-v2-to-v1-nodes.js) must also be rejected.
  {
    const { cmpInst, x, c, facts } = runBranchFacts({ sub: 'sub', extra: { conditional: true, fallbackNzcv: 4 } }, 'ge');
    assert.equal(facts.filter((f) => f.kind === FACT.BRANCH).length, 1);
    assert.equal(facts.filter((f) => f.kind === FACT.THRESHOLD).length, 0);
    assert.equal(canonicalThresholdComparison({ cmp: cmpInst, value: x, other: c, cond: 'ge' }), null);

    // proveClampSelect must also reject conditional compare.
    const selDst = mkVal('x8');
    const sel = {
      id: nextId++,
      op: OP.SEL,
      sub: 'sel',
      cond: 'ge',
      row: 3,
      address: 0x1008n,
      args: [{ value: x }, { value: c }, { value: cmpInst.dst }],
      dst: selDst,
    };
    assert.equal(proveClampSelect(sel), null);
  }

  // Positive control: plain unconditional cmp (sub: 'sub') still extracts THRESHOLD.
  {
    const { facts } = runBranchFacts({ sub: 'sub' }, 'lt');
    assert.equal(facts.filter((f) => f.kind === FACT.BRANCH).length, 1);
    const thresholds = facts.filter((f) => f.kind === FACT.THRESHOLD);
    assert.equal(thresholds.length, 1);
    assert.equal(thresholds[0].threshold, 8n);
    assert.equal(thresholds[0].operator, '<');
  }
});

test('Bug 4 (P1): legacy-stack-compat-repair supports DominanceView for cross-block dominance checks', () => {
  // Build a 4-block diamond CFG: 0 -> 1, 2; 1 -> 3; 2 -> 3.
  const cfg = analyzeGraph([[1, 2], [3], [3], []], 0);
  // Confirm cfg.dominators[3] is a DominanceView (NOT a Set) with .has().
  assert.equal(cfg.dominators[3] instanceof Set, false);
  assert.equal(typeof cfg.dominators[3].has, 'function');
  assert.equal(cfg.dominators[3].has(0), true);
  assert.equal(cfg.dominators[3].has(1), false);

  function buildDiamondProjection(baseBlock) {
    const baseDef = { id: 100, op: 'load', block: baseBlock, row: 1 };
    const baseVal = { id: 1, vid: 1, kind: 'def', bits: 64, def: baseDef, uses: [] };
    baseDef.dst = baseVal;

    const v1 = { id: 2, vid: 2, kind: 'const', bits: 32, const: 1n, uses: [] };
    const v2 = { id: 3, vid: 3, kind: 'const', bits: 32, const: 2n, uses: [] };

    const store1 = {
      id: 101,
      op: 'store',
      block: 1,
      row: 10,
      size: 4,
      loc: { kind: 'field', key: 'field:obj+0x8', baseEntityId: 'obj', base: baseVal, disp: 8n, size: 4 },
      addr: { base: baseVal, disp: 8n, size: 4 },
      args: [{ value: v1, bits: 32 }],
    };
    const store2 = {
      id: 102,
      op: 'store',
      block: 2,
      row: 20,
      size: 4,
      loc: { kind: 'field', key: 'field:obj+0x8', baseEntityId: 'obj', base: baseVal, disp: 8n, size: 4 },
      addr: { base: baseVal, disp: 8n, size: 4 },
      args: [{ value: v2, bits: 32 }],
    };

    const phiInst = {
      id: 103,
      op: 'phi',
      block: 3,
      row: 30,
      incoming: [{ from: 1, value: v1 }, { from: 2, value: v2 }],
    };
    const phiVal = { id: 4, vid: 4, kind: 'def', bits: 32, def: phiInst, uses: [] };
    phiInst.dst = phiVal;

    const stackStore = {
      id: 104,
      op: 'store',
      block: 3,
      row: 31,
      size: 4,
      loc: { kind: 'stack', key: 'stack:16', disp: 16n, size: 4 },
      addr: { disp: 16n, size: 4 },
      args: [{ value: phiVal, bits: 32 }],
    };
    phiVal.uses.push(stackStore);

    const blocks = [
      { id: 0, pred: [], succ: [1, 2], insts: baseBlock === 0 ? [baseDef] : [] },
      { id: 1, pred: [0], succ: [3], insts: baseBlock === 1 ? [baseDef, store1] : [store1] },
      { id: 2, pred: [0], succ: [3], insts: [store2] },
      { id: 3, pred: [1, 2], succ: [], insts: [phiInst, stackStore] },
    ];
    const projected = {
      blocks,
      instructions: [baseDef, store1, store2, phiInst, stackStore],
      values: [baseVal, v1, v2, phiVal],
      dominators: cfg.dominators,
    };
    restoreLegacyPrivateStackForwarding(projected, () => null);
    return stackStore;
  }

  // Base defined in dominating block 0 must succeed with DominanceView.
  const dominatingSpill = buildDiamondProjection(0);
  assert.equal(dominatingSpill.extra?.compatPhiFieldSpill, true);
  assert.equal(dominatingSpill.extra?.compatPhiFieldIdentity, 'field:obj+0x8');

  // Base defined in non-dominating branch block 1 must fail closed.
  const nonDominatingSpill = buildDiamondProjection(1);
  assert.notEqual(nonDominatingSpill.extra?.compatPhiFieldSpill, true);
});

test('Bug 5 (P2): comprehend.js findSink does not fall through past a tail call', () => {
  const accExpr = { k: 'bin', op: 'mul', a: { k: 'reg', r: 'x0' }, b: { k: 'const', v: 3n } };
  const acc = {
    reg: 'x8',
    steps: [{ row: 0, after: accExpr }],
  };

  // Row 0 computes x8; Row 1 is a tail call (does NOT pass x8 as an argument);
  // Row 2 is an unrelated sibling return that references accExpr in x0.
  const model = {
    instructions: [
      { row: 0, address: 0x1000n, mnemonic: 'mul', reads: ['x0'], isBranch: false, isCall: false, isReturn: false },
      { row: 1, address: 0x1004n, mnemonic: 'b', reads: [], isBranch: true, isCall: true, isTailCall: true, isReturn: false, branchTarget: 0x2000n },
      { row: 2, address: 0x1008n, mnemonic: 'ret', reads: ['x0'], isBranch: false, isCall: false, isReturn: true },
    ],
    calls: [
      { row: 1, target: 0x2000n, name: 'external_tail_target', isTailCall: true },
    ],
  };

  const vgNotPassed = {
    memWrites: [],
    defs: new Map(),
    at(row, reg) {
      if (row === 2 && reg === 'x0') return accExpr;
      return null;
    },
  };
  assert.equal(
    findSink(model, vgNotPassed, acc),
    null,
    'findSink must terminate at tail call instead of falling through to row 2',
  );

  // Positive control: if the tail call consumes accExpr in x0, it IS reported as an argument sink.
  const vgPassed = {
    memWrites: [],
    defs: new Map(),
    at(row, reg) {
      if (row === 1 && reg === 'x0') return accExpr;
      if (row === 2 && reg === 'x0') return accExpr;
      return null;
    },
  };
  const sink = findSink(model, vgPassed, acc);
  assert.equal(sink?.kind, 'argument');
  assert.equal(sink?.row, 1);
  assert.equal(sink?.index, 0);
  assert.equal(sink?.name, 'external_tail_target');
});

test('Bug 6 (P2): types-legacy.js structToC handles null/undefined and missing members without crashing', () => {
  assert.equal(structToC(null), '');
  assert.equal(structToC(undefined), '');
  assert.equal(structToC('not-a-struct'), '');

  const store = new TypeStore(null);
  assert.equal(store.toC('NonExistentStruct'), '');

  const minimal = structToC({ name: 'EmptyStruct' });
  assert.match(minimal, /^struct EmptyStruct \{/);
  assert.match(minimal, /\};   \/\/ 全体で 0 バイト$/);

  const valid = structToC({
    name: 'Player',
    size: 16,
    members: [
      { offset: 0, size: 4, type: 'int32', name: 'hp' },
      { offset: 8, size: 8, type: 'uint64', name: 'gold' },
    ],
  });
  assert.ok(valid.includes('struct Player {'));
  assert.ok(valid.includes('int32 hp;'));
  assert.ok(valid.includes('uint8 pad_4[4];'));
  assert.ok(valid.includes('uint64 gold;'));
  assert.ok(valid.includes('};   // 全体で 16 バイト'));
});
