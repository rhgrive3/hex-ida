import test from 'node:test';
import assert from 'node:assert/strict';

import { recoverExactStackReturn } from '../../js/decompiler/passes/stack-return-recovery.js';
import { decompileSemantic, reachingRegisterValue } from '../../js/decompiler/semantic-core.js';
import { enhanceSemanticDecompilation } from '../../js/decompiler/pipeline.js';
import { enhanceSemanticDecompilation as enhanceCore } from '../../js/decompiler/pipeline-core.js';
import { expr } from '../../js/decompiler/ast/nodes.js';

function makeStackLoadExpr(key, bits = 64) {
  return expr.load(
    { kind: 'stack', key, name: 'var_8', text: 'var_8', size: bits / 8 },
    bits,
    { rows: [3], addresses: [0x10cn], ir: ['i3'] },
  );
}

test('Fix 1a: recoverExactStackReturn scopes rewrite to target ret in multi-return functions', () => {
  const v0 = { id: 'v0', reg: 'x0', bits: 64, const: 0n };
  const v42 = { id: 'v42', reg: 'x1', bits: 64, const: 42n };
  const vLoad = { id: 'vLoad', reg: 'x0', bits: 64 };

  const iConst0 = { id: 'i0', block: 0, row: 0, address: 0x100n, op: 'const', dst: v0, value: 0n, args: [] };
  const iRet1 = { id: 'i1', block: 0, row: 1, address: 0x104n, op: 'ret', args: [{ value: v0 }] };
  const iStore = {
    id: 'i2', block: 1, row: 2, address: 0x108n, op: 'store', size: 8,
    loc: { kind: 'stack', key: 'stack:-8', size: 8 },
    args: [{ value: v42 }],
  };
  const iLoad = {
    id: 'i3', block: 1, row: 3, address: 0x10cn, op: 'load', size: 8, dst: vLoad,
    loc: { kind: 'stack', key: 'stack:-8', size: 8 },
    args: [],
  };
  const iRet2 = { id: 'i4', block: 1, row: 4, address: 0x110n, op: 'ret', args: [{ value: vLoad }] };
  v0.def = iConst0;
  vLoad.def = iLoad;

  const loadExpr = makeStackLoadExpr('stack:-8', 64);
  const zeroExpr = expr.constant(0n, 64);
  const const42Expr = expr.constant(42n, 64);

  const result = {
    semantic: true,
    ir: {
      entry: 0,
      blocks: [
        { index: 0, pred: [], succ: [1], insts: [iConst0, iRet1] },
        { index: 1, pred: [0], succ: [], insts: [iStore, iLoad, iRet2] },
      ],
      instructions: [iConst0, iRet1, iStore, iLoad, iRet2],
      values: [v0, v42, vLoad],
      dominators: [new Set([0]), new Set([0, 1])],
    },
    semanticAst: {
      values: [
        { valueId: 'v0', expression: zeroExpr },
        { valueId: 'v42', expression: const42Expr },
        { valueId: 'vLoad', expression: loadExpr },
      ],
      outputs: [{ name: 'return', expression: loadExpr }],
    },
    cAst: {
      signature: 'int64_t fn(void)',
      declarations: [],
      body: [
        {
          kind: 'stmt', indent: 1, text: 'return 0;', row: 1,
          source: { rows: [1], addresses: [0x104n], ir: ['i1'] },
          semantic: { op: 'return', ir: 'i1', expression: zeroExpr },
        },
        {
          kind: 'stmt', indent: 1, text: 'return var_8;', row: 4,
          source: { rows: [4], addresses: [0x110n], ir: ['i4'] },
          semantic: { op: 'return', ir: 'i4', expression: loadExpr },
        },
      ],
    },
  };

  recoverExactStackReturn(result, {});

  assert.equal(result.cAst.body[0].text, 'return 0;', 'early return must not be overwritten');
  assert.equal(result.cAst.body[1].text, 'return 42;', 'target return should be rewritten to 42');
});

test('Fix 1b: recoverExactStackReturn rejects non-stack stores and width-mismatched stack stores', () => {
  const vWide = { id: 'vWide', reg: 'x1', bits: 64, const: 0x1122334455667788n };
  const vNarrow = { id: 'vNarrow', reg: 'w2', bits: 32, const: 7n };
  const vLoad = { id: 'vLoad', reg: 'x0', bits: 64 };

  // Case A: older 8-byte store followed by narrower 4-byte store to same stack slot
  const iWideStore = {
    id: 'i0', block: 0, row: 0, address: 0x100n, op: 'store', size: 8,
    loc: { kind: 'stack', key: 'stack:-16', size: 8 },
    args: [{ value: vWide }],
  };
  const iNarrowStore = {
    id: 'i1', block: 0, row: 1, address: 0x104n, op: 'store', size: 4,
    loc: { kind: 'stack', key: 'stack:-16', size: 4 },
    args: [{ value: vNarrow }],
  };
  const iLoad = {
    id: 'i2', block: 0, row: 2, address: 0x108n, op: 'load', size: 8, dst: vLoad,
    loc: { kind: 'stack', key: 'stack:-16', size: 8 },
    args: [],
  };
  const iRet = { id: 'i3', block: 0, row: 3, address: 0x10cn, op: 'ret', args: [{ value: vLoad }] };
  vLoad.def = iLoad;

  const loadExpr = makeStackLoadExpr('stack:-16', 64);
  const resNarrow = {
    semantic: true,
    ir: {
      entry: 0,
      blocks: [{ index: 0, pred: [], succ: [], insts: [iWideStore, iNarrowStore, iLoad, iRet] }],
      instructions: [iWideStore, iNarrowStore, iLoad, iRet],
      values: [vWide, vNarrow, vLoad],
      dominators: [new Set([0])],
    },
    semanticAst: {
      values: [
        { valueId: 'vWide', expression: expr.constant(0x1122334455667788n, 64) },
        { valueId: 'vNarrow', expression: expr.constant(7n, 32) },
        { valueId: 'vLoad', expression: loadExpr },
      ],
      outputs: [{ name: 'return', expression: loadExpr }],
    },
    cAst: {
      signature: 'int64_t fn(void)',
      declarations: [],
      body: [{
        kind: 'stmt', indent: 1, text: 'return var_8;', row: 3,
        source: { rows: [3], addresses: [0x10cn], ir: ['i3'] },
        semantic: { op: 'return', ir: 'i3', expression: loadExpr },
      }],
    },
  };

  recoverExactStackReturn(resNarrow, {});
  assert.equal(resNarrow.cAst.body[0].text, 'return var_8;', '4-byte partial overwrite must block 8-byte recovery');

  // Case B: non-stack store with matching key must not be treated as a stack store
  const iGlobalStore = {
    id: 'i0g', block: 0, row: 0, address: 0x100n, op: 'store', size: 8,
    loc: { kind: 'global', key: 'stack:-16', size: 8 },
    args: [{ value: vWide }],
  };
  const resNonStack = {
    semantic: true,
    ir: {
      entry: 0,
      blocks: [{ index: 0, pred: [], succ: [], insts: [iGlobalStore, iLoad, iRet] }],
      instructions: [iGlobalStore, iLoad, iRet],
      values: [vWide, vLoad],
      dominators: [new Set([0])],
    },
    semanticAst: {
      values: [
        { valueId: 'vWide', expression: expr.constant(0x1122334455667788n, 64) },
        { valueId: 'vLoad', expression: loadExpr },
      ],
      outputs: [{ name: 'return', expression: loadExpr }],
    },
    cAst: {
      signature: 'int64_t fn(void)',
      declarations: [],
      body: [{
        kind: 'stmt', indent: 1, text: 'return var_8;', row: 3,
        source: { rows: [3], addresses: [0x10cn], ir: ['i3'] },
        semantic: { op: 'return', ir: 'i3', expression: loadExpr },
      }],
    },
  };

  recoverExactStackReturn(resNonStack, {});
  assert.equal(resNonStack.cAst.body[0].text, 'return var_8;', 'non-stack store must not satisfy stack return recovery');
});

test('Fix 2: emitRegion does not duplicate loop-header statements when loopRender returns null', () => {
  const v1 = { id: 'v1', reg: 'x0', bits: 64, const: 1n };
  const iConst = { id: 'i0', block: 0, row: 0, address: 0x100n, op: 'const', dst: v1, value: 1n, args: [] };
  const iStore = {
    id: 'i1', block: 0, row: 1, address: 0x104n, op: 'store', size: 8,
    loc: { kind: 'global', key: 'global:0x2000', address: 0x2000n, name: 'global_2000' },
    args: [{ value: v1 }],
  };
  const iBr = { id: 'i2', block: 0, row: 2, address: 0x108n, op: 'br', args: [], target: 0 };
  v1.def = iConst;

  const ir = {
    entry: 0,
    blocks: [
      { index: 0, startRow: 0, endRow: 2, pred: [0], succ: [0], insts: [iConst, iStore, iBr] },
    ],
    instructions: [iConst, iStore, iBr],
    values: [v1],
  };
  const model = {
    arch: 'arm64',
    instructions: ir.instructions.map((i) => ({
      row: i.row, address: i.address, mnemonic: 'nop', ops: [], reads: [], writes: [],
    })),
  };

  const res = decompileSemantic(model, { ir });
  const storeLines = (res.lines || []).filter((l) => /global_2000\s*=\s*1;/.test(l.text));
  assert.equal(storeLines.length, 1, `expected store emitted once, got:\n${res.pseudocode}`);
});

test('Fix 3: latestReturnStackLoad ignores non-dominating / unreachable stack loads', () => {
  const v99 = { id: 1, reg: 'x0', bits: 64, const: 99n };
  const vLoad = { id: 2, reg: 'x0', bits: 64 };

  const iConst99 = { id: 1, block: 0, row: 5, address: 0x100n, op: 'const', dst: v99, value: 99n, args: [] };
  const iBr = { id: 2, block: 0, row: 6, address: 0x104n, op: 'cbr', args: [], trueTarget: 1, falseTarget: 2 };
  const iLoad = {
    id: 3, block: 1, row: 10, address: 0x108n, op: 'load', size: 8, dst: vLoad,
    loc: { kind: 'stack', key: 'stack:-16', name: 'var_10', size: 8 },
    args: [],
  };
  const iRet = { id: 4, block: 2, row: 20, address: 0x110n, op: 'ret', args: [] };
  v99.def = iConst99;
  vLoad.def = iLoad;

  const ir = {
    entry: 0,
    blocks: [
      { index: 0, startRow: 5, endRow: 6, pred: [], succ: [1, 2], insts: [iConst99, iBr] },
      { index: 1, startRow: 10, endRow: 10, pred: [0], succ: [], insts: [iLoad] },
      { index: 2, startRow: 20, endRow: 20, pred: [0], succ: [], insts: [iRet] },
    ],
    instructions: [iConst99, iBr, iLoad, iRet],
    values: [v99, vLoad],
    dominators: [new Set([0]), new Set([0, 1]), new Set([0, 2])],
    idom: [-1, 0, 0],
    byRow: new Map([[5, [iConst99]], [6, [iBr]], [10, [iLoad]], [20, [iRet]]]),
  };

  const baseResult = {
    semantic: true,
    ir,
    types: { values: new Map(), ret: { type: 'int64', bits: 64 } },
    lines: [
      { kind: 'sig', indent: 0, text: 'int64_t fn(void)', row: 5, addr: 0x100n, source: { rows: [5], addresses: [0x100n], ir: [1] } },
      { kind: 'ctrl', indent: 0, text: '{', row: 5, addr: 0x100n, source: { rows: [], addresses: [], ir: [] } },
      { kind: 'stmt', indent: 1, text: 'return 99;', row: 20, addr: 0x110n, source: { rows: [20], addresses: [0x110n], ir: [4] } },
      { kind: 'ctrl', indent: 0, text: '}', row: 20, addr: 0x110n, source: { rows: [], addresses: [], ir: [] } },
    ],
    summary: [],
    evidence: [],
  };
  const model = { arch: 'arm64', instructions: [] };

  const abiAdapter = {
    supported: true,
    returnRegister: () => 'x0',
    returnLocations: () => [{ kind: 'register', reg: 'x0' }],
  };
  const enhanced = enhanceSemanticDecompilation(baseResult, model, { abiAdapter });
  const retOut = enhanced.semanticAst?.outputs?.find((o) => o.name === 'return');
  assert.ok(retOut, 'return output should exist');
  assert.notEqual(
    retOut.expression?.kind === 'load' && retOut.expression?.location?.key,
    'stack:-16',
    'unreachable non-dominating stack load must not re-anchor return output',
  );
  assert.equal(retOut.expression?.kind, 'const');
  assert.equal(retOut.expression?.value, 99n);
});

test('Fix 4: semantic-core reachingRegisterValue detects intervening non-dominating writes', () => {
  const v1 = { id: 1, reg: 'x0', bits: 64, const: 1n };
  const v2 = { id: 2, reg: 'x0', bits: 64, const: 2n };
  const v3 = { id: 3, reg: 'x0', bits: 64, const: 3n };

  const d0 = { id: 'i0', block: 0, row: 1, op: 'const', dst: v1 };
  const d1 = { id: 'i1', block: 1, row: 2, op: 'const', dst: v2 };
  const atRet = { id: 'i2', block: 2, row: 5, op: 'ret', args: [] };
  v1.def = d0;
  v2.def = d1;

  // Diamond: 0 -> 1 -> 2 and 0 -> 2. Block 1 overwrites x0 on a path to block 2.
  const irOverwritten = {
    blocks: [
      { index: 0, pred: [], succ: [1, 2], idom: -1 },
      { index: 1, pred: [0], succ: [2], idom: 0 },
      { index: 2, pred: [0, 1], succ: [], idom: 0 },
    ],
    dominators: [new Set([0]), new Set([0, 1]), new Set([0, 2])],
    idom: [-1, 0, 0],
    values: [v1, v2],
  };
  assert.equal(
    reachingRegisterValue(irOverwritten, atRet, 'x0'),
    null,
    'intervening write in branch arm must invalidate pre-branch dominating value',
  );

  // When block 1 does NOT reach block 2, dominating block 0 value still reaches block 2.
  const irDisjoint = {
    ...irOverwritten,
    blocks: [
      { index: 0, pred: [], succ: [1, 2], idom: -1 },
      { index: 1, pred: [0], succ: [], idom: 0 },
      { index: 2, pred: [0], succ: [], idom: 0 },
    ],
  };
  assert.equal(reachingRegisterValue(irDisjoint, atRet, 'x0'), v1);

  // A later same-block write in block 2 before atRet wins regardless of block 1.
  const d2 = { id: 'i3', block: 2, row: 4, op: 'const', dst: v3 };
  v3.def = d2;
  const irSameBlock = { ...irOverwritten, values: [v1, v2, v3] };
  assert.equal(reachingRegisterValue(irSameBlock, atRet, 'x0'), v3);
});

test('Fix 5: PassManager budget-exhaustion fallback preserves non-numeric string valueIds', () => {
  const vAlpha = { id: 'v_alpha', reg: 'x0', bits: 64, const: 11n };
  const vBeta = { id: 'v_beta', reg: 'x1', bits: 64, const: 22n };

  const i0 = { id: 'i0', block: 0, row: 0, address: 0x100n, op: 'const', dst: vAlpha, value: 11n, args: [] };
  const i1 = { id: 'i1', block: 0, row: 1, address: 0x104n, op: 'const', dst: vBeta, value: 22n, args: [] };
  const iRet = { id: 'i2', block: 0, row: 2, address: 0x108n, op: 'ret', args: [{ value: vAlpha }] };
  vAlpha.def = i0;
  vBeta.def = i1;

  const ir = {
    entry: 0,
    blocks: [{ index: 0, startRow: 0, endRow: 2, pred: [], succ: [], insts: [i0, i1, iRet] }],
    instructions: [i0, i1, iRet],
    values: [vAlpha, vBeta],
    dominators: [new Set([0])],
    idom: [-1],
    byRow: new Map([[0, [i0]], [1, [i1]], [2, [iRet]]]),
  };

  const baseResult = {
    semantic: true,
    ir,
    types: { values: new Map(), ret: { type: 'int64', bits: 64 } },
    lines: [
      { kind: 'sig', indent: 0, text: 'int64_t fn(void)', row: 0, addr: 0x100n, source: { rows: [0], addresses: [0x100n], ir: ['i0'] } },
      { kind: 'ctrl', indent: 0, text: '{', row: 0, addr: 0x100n, source: { rows: [], addresses: [], ir: [] } },
      { kind: 'stmt', indent: 1, text: 'return 11;', row: 2, addr: 0x108n, source: { rows: [2], addresses: [0x108n], ir: ['i2'] } },
      { kind: 'ctrl', indent: 0, text: '}', row: 2, addr: 0x108n, source: { rows: [], addresses: [], ir: [] } },
    ],
    summary: [],
    evidence: [],
  };
  const model = { arch: 'arm64', instructions: [] };

  // Exhaust budget right after canonical-expression-build (pass #4) so semantic-rewrite is skipped
  // and the !advanced.expressions fallback runs over advanced.expressionMemo.
  let ticks = 0;
  const enhanced = enhanceCore(baseResult, model, {
    decompilerTimeBudgetMs: 22,
    transformClock: () => ++ticks,
  });
  const rewriteMetric = (enhanced.passMetrics || []).find((m) => m.name === 'semantic-rewrite');
  const buildMetric = (enhanced.passMetrics || []).find((m) => m.name === 'canonical-expression-build');
  assert.ok(buildMetric && !buildMetric.skipped, 'canonical-expression-build should run');
  assert.ok(!rewriteMetric || rewriteMetric.skipped, 'semantic-rewrite should be skipped on budget exhaustion');

  const valueIds = (enhanced.semanticAst?.values || []).map((v) => v.valueId);
  assert.ok(valueIds.includes('v_alpha'), `expected 'v_alpha' in ${JSON.stringify(valueIds)}`);
  assert.ok(valueIds.includes('v_beta'), `expected 'v_beta' in ${JSON.stringify(valueIds)}`);
  assert.ok(!valueIds.some((id) => Number.isNaN(id)), 'must not produce NaN valueIds');
  const alphaEntry = enhanced.semanticAst.values.find((v) => v.valueId === 'v_alpha');
  const betaEntry = enhanced.semanticAst.values.find((v) => v.valueId === 'v_beta');
  assert.equal(alphaEntry?.expression?.value, 11n);
  assert.equal(betaEntry?.expression?.value, 22n);
});
