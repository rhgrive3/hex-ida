import assert from 'node:assert/strict';
import test from 'node:test';

import { runPassTransaction, seedAnalysisState } from '../js/decompiler/phase8/transaction.js';
import { SCCP_PASS, runSccpPass } from '../js/decompiler/phase8/sccp.js';
import { GVN_PASS, runGvnPass } from '../js/decompiler/phase8/valuenumber.js';
import { fixture } from './phase8/helpers/ir-fixtures.mjs';

import { OP, MK, VK } from '../js/ir-core.js';
import { recoverExactStackReturn } from '../js/decompiler/passes/stack-return-recovery.js';

import { expr } from '../js/decompiler/ast/nodes.js';
import { RewriteEngine } from '../js/decompiler/rewrite/engine.js';
import { DEFAULT_RULES } from '../js/decompiler/rewrite/rules.js';
import { evaluateExpression } from '../js/decompiler/verify/equivalence.js';

// ============================================================================
// 1. P1-S04-002: js/decompiler/phase8/valuenumber.js
//    Load congruence key must include memoryAccess.widthBits, extension kind,
//    and access attributes; unknown width or extension must be excluded.
// ============================================================================

function analyzeGvn(ir) {
  const state = seedAnalysisState(ir);
  const context = { analysis: state, ir };
  runPassTransaction(state, { descriptor: SCCP_PASS, run: runSccpPass }, context, {});
  const outcome = runPassTransaction(state, { descriptor: GVN_PASS, run: runGvnPass }, context, {});
  return { outcome, facts: state.get('valueNumbers') };
}

const PROVED_LOAD = Object.freeze({
  locKey: 'field:root+0',
  addressSpace: 'memory',
  volatility: 'unknown',
  atomic: false,
  ordering: null,
  memDefs: ['store_1'],
  addressPrecise: true,
});

test('[P1-S04-002] GVN separates loads with different memoryAccess.widthBits into same destination width', () => {
  const f = fixture('gvn-load-width-diff');
  f.block(0);
  const first = f.load(64, PROVED_LOAD);
  first.def.extra.memoryAccess.widthBits = 32;
  first.def.extra.signed = false;
  const second = f.load(64, PROVED_LOAD);
  second.def.extra.memoryAccess.widthBits = 64;
  f.ret();

  const { facts } = analyzeGvn(f.build());
  assert.notEqual(facts.numbers.get(first.id), facts.numbers.get(second.id));
  assert.equal(facts.reuseCandidates.some((c) => c.valueId === second.id), false);
});

test('[P1-S04-002] GVN separates sign-extended and zero-extended loads of same width', () => {
  const f = fixture('gvn-load-sext-vs-zext');
  f.block(0);
  const first = f.load(64, PROVED_LOAD);
  first.def.extra.memoryAccess.widthBits = 32;
  first.def.extra.signed = true;
  const second = f.load(64, PROVED_LOAD);
  second.def.extra.memoryAccess.widthBits = 32;
  second.def.extra.signed = false;
  f.ret();

  const { facts } = analyzeGvn(f.build());
  assert.notEqual(facts.numbers.get(first.id), facts.numbers.get(second.id));
  assert.equal(facts.reuseCandidates.some((c) => c.valueId === second.id), false);
});

test('[P1-S04-002] GVN still reuses identical widening loads with matching widthBits and extension', () => {
  const f = fixture('gvn-load-sext-reuse');
  f.block(0);
  const first = f.load(64, PROVED_LOAD);
  first.def.extra.memoryAccess.widthBits = 16;
  first.def.extra.signed = true;
  const second = f.load(64, PROVED_LOAD);
  second.def.extra.memoryAccess.widthBits = 16;
  second.def.extra.signed = true;
  f.ret();

  const { facts } = analyzeGvn(f.build());
  assert.equal(facts.numbers.get(first.id), facts.numbers.get(second.id));
  assert.equal(facts.reuseCandidates.some((c) => c.valueId === second.id && c.reuseOf === first.id), true);
});

test('[P1-S04-002] GVN excludes loads with unknown memoryAccess.widthBits or unknown extension kind', () => {
  // Missing widthBits
  const fWidth = fixture('gvn-load-unknown-width');
  fWidth.block(0);
  const w1 = fWidth.load(32, PROVED_LOAD);
  const w2 = fWidth.load(32, PROVED_LOAD);
  w1.def.extra.memoryAccess.widthBits = null;
  w2.def.extra.memoryAccess.widthBits = null;
  fWidth.ret();
  const { facts: widthFacts } = analyzeGvn(fWidth.build());
  assert.notEqual(widthFacts.numbers.get(w1.id), widthFacts.numbers.get(w2.id));
  assert.match(widthFacts.singletonReasons.get(w2.id) ?? '', /width is unknown/);

  // Widening load with missing extension kind
  const fExt = fixture('gvn-load-unknown-ext');
  fExt.block(0);
  const e1 = fExt.load(64, PROVED_LOAD);
  const e2 = fExt.load(64, PROVED_LOAD);
  e1.def.extra.memoryAccess.widthBits = 16;
  e2.def.extra.memoryAccess.widthBits = 16;
  fExt.ret();
  const { facts: extFacts } = analyzeGvn(fExt.build());
  assert.notEqual(extFacts.numbers.get(e1.id), extFacts.numbers.get(e2.id));
  assert.match(extFacts.singletonReasons.get(e2.id) ?? '', /extension kind is unknown/);

  // Explicit unknown extend attribute
  const fExplicitUnknown = fixture('gvn-load-explicit-unknown-ext');
  fExplicitUnknown.block(0);
  const u1 = fExplicitUnknown.load(32, PROVED_LOAD);
  const u2 = fExplicitUnknown.load(32, PROVED_LOAD);
  u1.def.extra.extend = 'unknown';
  u2.def.extra.extend = 'unknown';
  fExplicitUnknown.ret();
  const { facts: explicitFacts } = analyzeGvn(fExplicitUnknown.build());
  assert.notEqual(explicitFacts.numbers.get(u1.id), explicitFacts.numbers.get(u2.id));
  assert.match(explicitFacts.singletonReasons.get(u2.id) ?? '', /extension kind is unknown/);
});

test('[P1-S04-002] GVN separates loads with differing access attributes (endian, ordering)', () => {
  const f = fixture('gvn-load-attrs');
  f.block(0);
  const a = f.load(32, PROVED_LOAD);
  a.def.extra.memoryAccess.endian = 'little';
  const b = f.load(32, PROVED_LOAD);
  b.def.extra.memoryAccess.endian = 'big';
  const c = f.load(32, { ...PROVED_LOAD, ordering: 'relaxed' });
  c.def.extra.memoryAccess.endian = 'little';
  f.ret();

  const { facts } = analyzeGvn(f.build());
  assert.notEqual(facts.numbers.get(a.id), facts.numbers.get(b.id));
  assert.notEqual(facts.numbers.get(a.id), facts.numbers.get(c.id));
});

// ============================================================================
// 2. P2-S15-001: js/decompiler/passes/stack-return-recovery.js
//    committedStoreBarrier and unsafeBarrier fail closed on non-stack stores
//    and calls lacking proven non-overlapping memory effect summaries.
// ============================================================================

function makeStackScenario({ interveningInsts = [] } = {}) {
  const argVal = { id: 1, kind: VK.ARG, reg: 'x0', bits: 64, signed: false, def: null, uses: [] };
  const retVal = { id: 2, kind: VK.DEF, reg: 'x0', bits: 64, signed: false, def: null, uses: [] };
  const targetLoc = { kind: MK.STACK, key: 'stack:sp:c16:s8', baseReg: 'sp', frameEpoch: 0, disp: 16n, size: 8 };
  const storeInst = {
    id: 10, op: OP.STORE, block: 0, row: 1, address: 0x1004n,
    args: [{ value: argVal, bits: 64 }],
    loc: targetLoc,
    size: 8,
  };
  const loadInst = {
    id: 11, op: OP.LOAD, block: 0, row: 10, address: 0x1028n,
    dst: retVal,
    args: [],
    loc: targetLoc,
    size: 8,
  };
  retVal.def = loadInst;
  const retInst = {
    id: 12, op: OP.RET, block: 0, row: 11, address: 0x102cn,
    args: [{ value: retVal, bits: 64 }],
  };
  const insts = [storeInst, ...interveningInsts, loadInst, retInst];
  const block0 = {
    index: 0, id: 0, startRow: 0, endRow: 11, address: 0x1000n,
    insts, phis: [], pred: [], succ: [], idom: -1,
  };
  const ir = {
    blocks: [block0],
    instructions: insts,
    values: [argVal, retVal],
    idom: [-1],
    dominators: [new Set([0])],
  };
  const retExpr = expr.load(
    { kind: 'stack', key: targetLoc.key, size: 8 },
    64,
    { ir: [loadInst.id], rows: [loadInst.row], addresses: [loadInst.address] },
  );
  const result = {
    semantic: true,
    ir,
    semanticAst: {
      values: [
        { valueId: 1, expression: expr.variable('a1', 64, false) },
        { valueId: 2, expression: retExpr },
      ],
      conditions: [],
      stores: [],
      outputs: [{ name: 'return', expression: retExpr }],
    },
    cAst: {
      header: 'int64_t f(int64_t a1) {',
      footer: '}',
      body: [{
        kind: 'stmt', indent: 1, text: 'return local_16;',
        row: retInst.row, addr: retInst.address,
        source: { ir: [retInst.id], rows: [retInst.row], addresses: [retInst.address] },
        semantic: { op: 'return', ir: retInst.id, expression: retExpr },
      }],
    },
    lines: [],
    pseudocode: '',
  };
  return { result };
}

test('[P2-S15-001] unsafeBarrier fails closed on calls with missing or empty memKills and unknown kills', () => {
  const callMissingKills = { id: 20, op: OP.CALL, block: 0, row: 2, address: 0x1008n, args: [] };
  const callEmptyKills = { id: 21, op: OP.CALL, block: 0, row: 2, address: 0x1008n, args: [], memKills: [] };
  const callUnknownKill = {
    id: 22, op: OP.CALL, block: 0, row: 2, address: 0x1008n, args: [],
    memKills: [{ kind: MK.UNKNOWN, key: 'unknown-barrier:22', size: null }],
  };
  const callNoWrite = {
    id: 23, op: OP.CALL, block: 0, row: 2, address: 0x1008n, args: [],
    extra: { memoryWrite: { scope: 'none' } },
  };

  for (const call of [callMissingKills, callEmptyKills, callUnknownKill]) {
    const s = makeStackScenario({ interveningInsts: [call] });
    recoverExactStackReturn(s.result);
    assert.equal(s.result.cAst.body[0].text, 'return local_16;', `call id=${call.id} must act as barrier`);
  }

  const sPure = makeStackScenario({ interveningInsts: [callNoWrite] });
  recoverExactStackReturn(sPure.result);
  assert.equal(sPure.result.cAst.body[0].text, 'return a1;', 'call proven memoryWrite.scope=none may allow recovery');
});

test('[P2-S15-001] unsafeBarrier fails closed on non-stack stores without proven stack-alias freedom', () => {
  const val = { id: 3, kind: VK.ARG, reg: 'x1', bits: 64, signed: false, def: null, uses: [] };
  const unprovedFieldStore = {
    id: 30, op: OP.STORE, block: 0, row: 2, address: 0x1008n,
    args: [{ value: val, bits: 64 }],
    loc: { kind: MK.FIELD, key: 'field:x2+0', size: 8 },
    size: 8,
  };
  const provedDisjointStore = {
    id: 31, op: OP.STORE, block: 0, row: 2, address: 0x1008n,
    args: [{ value: val, bits: 64 }],
    loc: { kind: MK.FIELD, key: 'field:x2+0', size: 8, stackAliasFree: true },
    size: 8,
  };

  const sBlocked = makeStackScenario({ interveningInsts: [unprovedFieldStore] });
  recoverExactStackReturn(sBlocked.result);
  assert.equal(sBlocked.result.cAst.body[0].text, 'return local_16;');

  const sAllowed = makeStackScenario({ interveningInsts: [provedDisjointStore] });
  recoverExactStackReturn(sAllowed.result);
  assert.equal(sAllowed.result.cAst.body[0].text, 'return a1;');
});

function makeCommittedPhiScenario({ interveningInArm = [] } = {}) {
  const v1 = { id: 1, kind: VK.ARG, reg: 'x1', bits: 64, signed: false, def: null, uses: [] };
  const v2 = { id: 2, kind: VK.ARG, reg: 'x2', bits: 64, signed: false, def: null, uses: [] };
  const phiVal = { id: 3, kind: VK.PHI, reg: 'x0', bits: 64, signed: false, def: null, uses: [] };
  const loadVal = { id: 4, kind: VK.DEF, reg: 'x0', bits: 64, signed: false, def: null, uses: [] };

  const outLoc = { kind: MK.FIELD, key: 'field:x3+0', size: 8 };
  const stackLoc = { kind: MK.STACK, key: 'stack:sp:c16:s8', baseReg: 'sp', frameEpoch: 0, disp: 16n, size: 8 };

  const storeArm1 = { id: 101, op: OP.STORE, block: 1, row: 1, address: 0x2004n, args: [{ value: v1, bits: 64 }], loc: outLoc, size: 8 };
  const storeArm2 = { id: 102, op: OP.STORE, block: 2, row: 1, address: 0x2014n, args: [{ value: v2, bits: 64 }], loc: outLoc, size: 8 };
  const phiInst = { id: 103, op: OP.PHI, block: 3, row: 0, dst: phiVal, incoming: [{ from: 1, value: v1 }, { from: 2, value: v2 }] };
  phiVal.def = phiInst;
  const spillInst = {
    id: 104, op: OP.STORE, block: 3, row: 1, address: 0x2020n,
    args: [{ value: phiVal, bits: 64 }],
    loc: stackLoc,
    size: 8,
    memDef: { definitionId: 'mdef-1' },
  };
  const loadInst = {
    id: 105, op: OP.LOAD, block: 3, row: 2, address: 0x2024n,
    dst: loadVal,
    args: [],
    loc: stackLoc,
    size: 8,
    memoryForwarding: {
      exact: true,
      contributingDefinitionIds: ['mdef-1'],
      loadLocationKey: stackLoc.key,
    },
    memoryForwardingContext: {
      loadInstructionId: 105,
      loadLocationKey: stackLoc.key,
    },
  };
  loadVal.def = loadInst;
  const retInst = { id: 106, op: OP.RET, block: 3, row: 3, address: 0x2028n, args: [{ value: loadVal, bits: 64 }] };

  const b0 = { index: 0, pred: [], succ: [1, 2], insts: [] };
  const b1 = { index: 1, pred: [0], succ: [3], insts: [storeArm1, ...interveningInArm] };
  const b2 = { index: 2, pred: [0], succ: [3], insts: [storeArm2] };
  const b3 = { index: 3, pred: [1, 2], succ: [], phis: [phiInst], insts: [spillInst, loadInst, retInst] };
  const instructions = [storeArm1, ...interveningInArm, storeArm2, phiInst, spillInst, loadInst, retInst];
  const ir = {
    blocks: [b0, b1, b2, b3],
    instructions,
    values: [v1, v2, phiVal, loadVal],
    idom: new Map([[0, 0], [1, 0], [2, 0], [3, 0]]),
  };
  const semOutLoc = { kind: 'field', base: expr.variable('a4', 64, false), offset: 0, name: 'out' };
  const retExpr = expr.load(stackLoc, 64, { ir: [105], rows: [2], addresses: [0x2024n] });
  const result = {
    semantic: true,
    ir,
    semanticAst: {
      values: [],
      stores: [
        { source: { ir: [101] }, location: semOutLoc },
        { source: { ir: [102] }, location: semOutLoc },
      ],
      outputs: [{ name: 'return', expression: retExpr }],
    },
    cAst: {
      header: 'int64_t f(void) {',
      footer: '}',
      body: [{
        kind: 'stmt', indent: 1, text: 'return local_16;',
        row: retInst.row, addr: retInst.address,
        source: { ir: [retInst.id], rows: [retInst.row], addresses: [retInst.address] },
        semantic: { op: 'return', ir: retInst.id, expression: retExpr },
      }],
    },
    lines: [],
    pseudocode: '',
  };
  return { result };
}

test('[P2-S15-001] committedStoreBarrier fails closed on later non-stack store and calls without memKills', () => {
  const otherVal = { id: 9, kind: VK.ARG, reg: 'x5', bits: 64, signed: false, def: null, uses: [] };
  const clobberingStore = {
    id: 201, op: OP.STORE, block: 1, row: 2, address: 0x2008n,
    args: [{ value: otherVal, bits: 64 }],
    loc: { kind: MK.FIELD, key: 'field:x6+0', size: 8 },
    size: 8,
  };
  const callMissingKills = { id: 202, op: OP.CALL, block: 1, row: 2, address: 0x2008n, args: [] };
  const callEmptyKills = { id: 203, op: OP.CALL, block: 1, row: 2, address: 0x2008n, args: [], memKills: [] };

  for (const inst of [clobberingStore, callMissingKills, callEmptyKills]) {
    const s = makeCommittedPhiScenario({ interveningInArm: [inst] });
    recoverExactStackReturn(s.result);
    assert.equal(s.result.cAst.body[0].text, 'return local_16;', `intervening inst id=${inst.id} must block committed phi return`);
  }
});

// ============================================================================
// 3. Hotspot: js/decompiler/rewrite/rules.js (`collapse-nested-extract`)
//    Must check inner node's declared output width truncation and must NOT
//    truncate combined offset lsb modulo outer n.bits.
// ============================================================================

test('[Hotspot rules.js] collapse-nested-extract rejects collapse when inner node bits truncate outer slice', () => {
  const engine = new RewriteEngine(DEFAULT_RULES);
  const x = expr.variable('x', 64, false);
  // Inner extract declares width=16, but its typed node output width is only 8 bits.
  const inner = expr.intrinsic('bit_extract', [x, expr.constant(4n, 64), expr.constant(16n, 64)], 8, false);
  // Outer reads bits [4, 12) of inner, which crosses inner.bits=8.
  const outer = expr.intrinsic('bit_extract', [inner, expr.constant(4n, 64), expr.constant(8n, 64)], 8, false);

  const { root: rewritten, proof } = engine.rewrite(outer);
  assert.equal(
    proof.some((r) => r.rule === 'collapse-nested-extract'),
    false,
    'must not collapse when outerLsb + outerWidth exceeds inner.bits',
  );
  assert.equal(rewritten.args[0].kind, 'intrinsic');
  assert.equal(rewritten.args[0].name, 'bit_extract');
});

test('[Hotspot rules.js] collapse-nested-extract does not truncate combined lsb modulo outer n.bits', () => {
  const engine = new RewriteEngine(DEFAULT_RULES);
  const x = expr.variable('x', 64, false);

  // Outer output width is 1 bit; combined lsb = 8 + 4 = 12 (previously truncated to 12 & 1 = 0!).
  const inner1 = expr.intrinsic('bit_extract', [x, expr.constant(8n, 64), expr.constant(16n, 64)], 32, false);
  const outer1 = expr.intrinsic('bit_extract', [inner1, expr.constant(4n, 64), expr.constant(1n, 64)], 1, false);
  const { root: rewritten1, proof: proof1 } = engine.rewrite(outer1);

  assert.equal(proof1.some((r) => r.rule === 'collapse-nested-extract'), true);
  assert.equal(rewritten1.kind, 'intrinsic');
  assert.equal(rewritten1.name, 'bit_extract');
  assert.equal(rewritten1.args[0].kind, 'var');
  assert.equal(rewritten1.args[1].value, 12n, 'combined lsb must remain 12n, not truncated to 1-bit');
  assert.ok(rewritten1.args[1].bits >= 64);

  // Outer output width is 4 bits; combined lsb = 12 + 8 = 20 (previously truncated to 20 & 15 = 4!).
  const inner2 = expr.intrinsic('bit_extract', [x, expr.constant(12n, 64), expr.constant(16n, 64)], 32, false);
  const outer2 = expr.intrinsic('bit_extract', [inner2, expr.constant(8n, 64), expr.constant(4n, 64)], 4, false);
  const { root: rewritten2, proof: proof2 } = engine.rewrite(outer2);

  assert.equal(proof2.some((r) => r.rule === 'collapse-nested-extract'), true);
  assert.equal(rewritten2.kind, 'intrinsic');
  assert.equal(rewritten2.name, 'bit_extract');
  assert.equal(rewritten2.args[1].value, 20n, 'combined lsb must remain 20n, not truncated to 4-bit');

  for (const sample of [0n, 1n, 0x123456789abcdef0n, 0xffffffffffffffffn, 1n << 12n, 0xan << 20n]) {
    assert.equal(evaluateExpression(rewritten1, { x: sample }), evaluateExpression(outer1, { x: sample }));
    assert.equal(evaluateExpression(rewritten2, { x: sample }), evaluateExpression(outer2, { x: sample }));
  }
});

test('[Hotspot rules.js] collapse-nested-extract allows collapse when outer slice stays within min(innerWidth, inner.bits)', () => {
  const engine = new RewriteEngine(DEFAULT_RULES);
  const x = expr.variable('x', 64, false);
  const inner = expr.intrinsic('bit_extract', [x, expr.constant(4n, 64), expr.constant(16n, 64)], 8, false);
  const outer = expr.intrinsic('bit_extract', [inner, expr.constant(2n, 64), expr.constant(6n, 64)], 8, false);

  const { root: rewritten, proof } = engine.rewrite(outer);
  assert.equal(proof.some((r) => r.rule === 'collapse-nested-extract'), true);
  assert.equal(rewritten.args[0].kind, 'var');
  assert.equal(rewritten.args[1].value, 6n);
  assert.equal(rewritten.args[2].value, 6n);
});
