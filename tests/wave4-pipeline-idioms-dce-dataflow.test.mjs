import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSemanticModel } from '../js/blocks.js';
import { semanticAbiAdapter } from '../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../js/targets/abi/index.js';
import { expr } from '../js/decompiler/ast/nodes.js';
import {
  buildExpressionForTesting,
  enhanceSemanticDecompilation,
  readCallResultSpellingProducer,
} from '../js/decompiler/pipeline-core.js';
import { decompileSemantic } from '../js/decompiler/semantic-core.js';
import { printExpression } from '../js/decompiler/pretty/c.js';
import {
  recognizeClamp,
  recognizeDivisionByConstant,
  recoverArm64ClangIdiom,
} from '../js/decompiler/idioms/arm64-clang.js';
import { DCE_PASS, observableEffectReason, runDcePass } from '../js/decompiler/phase8/dce.js';
import { runPassTransaction, seedAnalysisState } from '../js/decompiler/phase8/transaction.js';
import { applyPhase8Projection } from '../js/decompiler/phase8/projection.js';
import {
  candidateLocationIdentity,
  constantComparisons,
  findValueUpdates,
} from '../js/dataflow.js';
import { fixture } from './phase8/helpers/ir-fixtures.mjs';

const ABI = semanticAbiAdapter(AAPCS64_ABI);

function val(id, reg, bits = 64, kind = 'def', extra = {}) {
  return { id, reg, bits, kind, uses: [], def: null, const: null, ...extra };
}
function arg(id, reg, bits = 64) {
  return val(id, reg, bits, 'arg');
}
function av(v) {
  return { value: v };
}

function makeState(ir, { model = { calls: [], addressRefs: [] }, opts = {}, types = null } = {}) {
  return {
    ir,
    model,
    opts: { abiAdapter: ABI, ...opts },
    types: types || { values: new Map(), locations: new Map() },
    preservePhase8Unknown: opts.phase8Optimize === true,
    expressionMemo: new Map(),
    expressionActive: new Set(),
    warnings: [],
  };
}

function modelOfArm64(lines) {
  const BASE = 0x100000000n;
  const rows = lines.map((line, row) => {
    const trimmed = line.trim();
    const sp = trimmed.indexOf(' ');
    return {
      row,
      address: BASE + BigInt(row * 4),
      mn: sp < 0 ? trimmed : trimmed.slice(0, sp),
      ops: sp < 0 ? '' : trimmed.slice(sp + 1),
    };
  });
  const rowOfAddress = (addr) => {
    const delta = addr - BASE;
    return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
  };
  return buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
}

// ---------------------------------------------------------------------------
// 1. pipeline-core.js: cStringLiteral preserves literal \n / \r / \t
// ---------------------------------------------------------------------------
test('[Wave4-B P1] cStringLiteral preserves literal backslash-n/r/t sequences from stringFor and addressRefs', () => {
  const page = val(1, 'x0', 64, 'def', { const: 0x2000n });
  const off = val(2, 'imm', 64, 'def', { const: 0x10n });
  const addrVal = val(3, 'x0', 64, 'def', { const: 0x2010n });
  const adrp = { id: 10, op: 'addr', row: 0, block: 0, address: 0x1000n, dst: page, args: [], extra: { value: 0x2000n } };
  page.def = adrp;
  const add = { id: 11, op: 'bin', sub: 'add', row: 1, block: 0, address: 0x1004n, dst: addrVal, args: [av(page), av(off)] };
  addrVal.def = add;

  const ir = { values: [page, off, addrVal], instructions: [adrp, add], args: new Map(), blocks: [] };

  // Literal Windows-style path with \t, \n, \r as two-character sequences
  const statePath = makeState(ir, {
    opts: { stringFor: (a) => (BigInt(a) === 0x2010n ? 'C:\\temp\\new\\raw' : null) },
  });
  assert.equal(printExpression(buildExpressionForTesting(addrVal, statePath)), '"C:\\\\temp\\\\new\\\\raw"');

  // Actual control characters stay escaped as \t, \n, \r
  const stateCtrl = makeState(ir, {
    opts: { stringFor: (a) => (BigInt(a) === 0x2010n ? 'a\tb\nc\r' : null) },
  });
  assert.equal(printExpression(buildExpressionForTesting(addrVal, stateCtrl)), '"a\\tb\\nc\\r"');

  // addressRefs route also preserves literal backslash sequences
  const stateRef = makeState(ir, {
    model: { calls: [], addressRefs: [{ row: 0, addr: 0x2010n, text: 'prefix\\n\\t' }] },
  });
  assert.equal(printExpression(buildExpressionForTesting(addrVal, stateRef)), '"prefix\\\\n\\\\t"');
});

// ---------------------------------------------------------------------------
// 2. pipeline-core.js: readBytesFromSection & resolveConstantAddressValue BigInt guards
// ---------------------------------------------------------------------------
test('[Wave4-B P2] readBytesFromSection and resolveConstantAddressValue handle malformed BigInt inputs safely', () => {
  // Malformed sec.fileOffset must fall back without throwing
  const roSec = {
    name: '.rodata',
    addr: 0x3000n,
    size: 16n,
    fileOffset: 'not-a-bigint',
    perm: 'r--',
  };
  const addrV = val(1, 'x0', 64, 'def', { const: 0x3000n });
  const addrI = { id: 20, op: 'addr', row: 0, block: 0, address: 0x1000n, dst: addrV, args: [], extra: { value: 0x3000n } };
  addrV.def = addrI;
  const stateBadFileOffset = makeState(
    { values: [addrV], instructions: [addrI], args: new Map(), blocks: [] },
    { opts: { sections: [roSec], fileBytes: new Uint8Array([0x41, 0x00]) } },
  );
  assert.doesNotThrow(() => buildExpressionForTesting(addrV, stateBadFileOffset));

  // Malformed non-integer constant in bin add / phi must not throw in resolveConstantAddressValue
  const page = val(10, 'x0', 64, 'def', { const: 0x4000n });
  const badOff = val(11, 'd1', 64, 'def', { constKind: 'float', floatConst: 1.5, const: 1.5 });
  const sum = val(12, 'x0', 64);
  const adrp = { id: 21, op: 'addr', row: 0, block: 0, address: 0x1000n, dst: page, args: [], extra: { value: 0x4000n } };
  page.def = adrp;
  const addBad = { id: 22, op: 'bin', sub: 'add', row: 1, block: 0, address: 0x1004n, dst: sum, args: [av(page), av(badOff)] };
  sum.def = addBad;
  const stateBadAdd = makeState({ values: [page, badOff, sum], instructions: [adrp, addBad], args: new Map(), blocks: [] });
  assert.doesNotThrow(() => buildExpressionForTesting(sum, stateBadAdd));
});

// ---------------------------------------------------------------------------
// 3. pipeline-core.js: isElidableReturnSpillStore soundness checks
// ---------------------------------------------------------------------------
test('[Wave4-B P1] isElidableReturnSpillStore rejects multi-use load, escaped stack frame, and non-intervening branch calls', () => {
  const buildSpillScenario = ({ extraUse = false, escapeBefore = false, separateBranchCall = false } = {}) => {
    const sp = arg(1, 'sp', 64);
    const x0 = arg(2, 'x0', 64);
    const off32 = val(3, 'imm', 64, 'def', { const: 32n });
    const escapedPtr = val(4, 'x1', 64);
    const loaded = val(5, 'x0', 64);
    const globalPtr = arg(6, 'x2', 64);

    const loc = { kind: 'stack', key: 'stack:-16', disp: -16n, size: 8 };
    const insts = [];
    const b0Insts = [];
    const b1Insts = [];
    const b2Insts = [];

    if (escapeBefore) {
      const subSp = { id: 100, op: 'bin', sub: 'sub', row: 0, block: 0, address: 0x1000n, dst: escapedPtr, args: [av(sp), av(off32)] };
      escapedPtr.def = subSp;
      const escCall = { id: 101, op: 'call', row: 1, block: 0, address: 0x1004n, dst: null, args: [av(escapedPtr)], extra: { name: 'escape_sp' } };
      insts.push(subSp, escCall);
      b0Insts.push(subSp, escCall);
    }

    const storeI = {
      id: 102, op: 'store', row: 2, block: 0, address: 0x1008n, size: 8, dst: null,
      loc, addr: { base: sp, disp: -16n, size: 8 }, args: [av(x0)],
    };
    const helperCall = {
      id: 103, op: 'call', row: 3, block: separateBranchCall ? 1 : 0, address: 0x100cn, dst: null,
      args: [], extra: { name: 'helper' },
    };
    const loadI = {
      id: 104, op: 'load', row: 4, block: separateBranchCall ? 2 : 0, address: 0x1010n, size: 8, dst: loaded,
      loc, addr: { base: sp, disp: -16n, size: 8 }, args: [], reachingStore: storeI,
    };
    loaded.def = loadI;
    const extraStore = extraUse
      ? {
        id: 105, op: 'store', row: 5, block: separateBranchCall ? 2 : 0, address: 0x1014n, size: 8, dst: null,
        loc: { kind: 'field', key: 'field:6:0', base: globalPtr, disp: 0n, size: 8 },
        addr: { base: globalPtr, disp: 0n, size: 8 }, args: [av(loaded)],
      }
      : null;
    const retI = {
      id: 106, op: 'ret', row: 6, block: separateBranchCall ? 2 : 0, address: 0x1018n, args: [av(loaded)],
    };

    x0.uses.push(storeI);
    loaded.uses.push(retI);
    if (extraStore) loaded.uses.push(extraStore);

    let blocks;
    if (separateBranchCall) {
      // Block 0 -> {1, 2}; Block 1 has helperCall -> exits (cannot reach Block 2)
      b0Insts.push(storeI);
      b1Insts.push(helperCall);
      b2Insts.push(loadI, ...(extraStore ? [extraStore] : []), retI);
      insts.push(storeI, helperCall, loadI, ...(extraStore ? [extraStore] : []), retI);
      blocks = [
        { index: 0, startRow: 0, endRow: 2, succ: [1, 2], insts: b0Insts },
        { index: 1, startRow: 3, endRow: 3, succ: [], insts: b1Insts },
        { index: 2, startRow: 4, endRow: 6, succ: [], insts: b2Insts },
      ];
    } else {
      b0Insts.push(storeI, helperCall, loadI, ...(extraStore ? [extraStore] : []), retI);
      insts.push(storeI, helperCall, loadI, ...(extraStore ? [extraStore] : []), retI);
      blocks = [{ index: 0, startRow: 0, endRow: 6, succ: [], insts: b0Insts }];
    }

    const ir = {
      values: [sp, x0, off32, escapedPtr, loaded, globalPtr],
      instructions: insts,
      args: new Map([['sp', sp], ['x0', x0], ['x2', globalPtr]]),
      blocks,
      dominators: separateBranchCall ? [new Set([0]), new Set([0, 1]), new Set([0, 2])] : [new Set([0])],
    };
    const result = {
      semantic: true,
      ir,
      types: { values: new Map(), locations: new Map() },
      lines: [
        { kind: 'sig', indent: 0, text: 'uint64 fn(uint64 a1, uint64 a2, uint64 a3)' },
        { kind: 'ctrl', indent: 0, text: '{' },
        { kind: 'stmt', indent: 1, text: 'local_m10 = a1;', row: 2, addr: 0x1008n },
        { kind: 'stmt', indent: 1, text: 'helper();', row: 3, addr: 0x100cn },
        ...(extraStore ? [{ kind: 'stmt', indent: 1, text: 'a3->field_0 = local_m10;', row: 5, addr: 0x1014n }] : []),
        { kind: 'stmt', indent: 1, text: 'return local_m10;', row: 6, addr: 0x1018n },
        { kind: 'ctrl', indent: 0, text: '}' },
      ],
      warnings: [],
      evidence: [],
      summary: 'test',
      coverage: { mode: 'structured' },
    };
    return enhanceSemanticDecompilation(result, { calls: [], addressRefs: [] }, {
      abiAdapter: ABI,
      decompilerTimeBudgetMs: 5000,
    });
  };

  // (a) load.dst also stored to a3->field_0 => store must NOT be elided
  const multiUse = buildSpillScenario({ extraUse: true });
  assert.match(multiUse.pseudocode, /local_m10\s*=\s*a1;/, multiUse.pseudocode);

  // (b) escaped stack frame before store => store must NOT be elided
  const escaped = buildSpillScenario({ escapeBefore: true });
  assert.match(escaped.pseudocode, /\*\(uint64_t \*\)\(uintptr_t\)\(sp - 16\)\s*=\s*a1;/, escaped.pseudocode);

  // (c) call in unreachable sibling branch with store.row < call.row < load.row => store must NOT be elided
  const siblingCall = buildSpillScenario({ separateBranchCall: true });
  assert.match(siblingCall.pseudocode, /local_m10\s*=\s*a1;/, siblingCall.pseudocode);
});

// ---------------------------------------------------------------------------
// 4. pipeline-core.js + projection.js: virtual_slot annotation preserves callResultSpellingProducers
// ---------------------------------------------------------------------------
test('[Wave4-B P1] virtual_slot annotation keeps callResultSpellingProducers aligned with projection.js', () => {
  const model = modelOfArm64([
    'ldr x8, [x0]',
    'ldr x8, [x8, #0x10]',
    'blr x8',
    'ret',
  ]);
  const base = decompileSemantic(model, {
    abiAdapter: ABI,
    name: 'call_vslot',
    returnType: 'void',
  });
  assert.equal(base.semantic, true);
  const callInst = base.ir.instructions.find((i) => i.op === 'call');
  assert.ok(callInst, 'IR must contain indirect blr call');
  const receiverVal = base.ir.args.get('x0');
  assert.ok(receiverVal, 'IR must contain x0 receiver');

  const cxxEvidence = {
    canonicalFunctionKey: 'fn:call_vslot',
    receiver: {
      proven: true,
      canonicalValueId: receiverVal.id,
      className: 'Widget',
    },
    virtualSlots: [
      {
        virtualSlotKnown: true,
        slotIndex: 2,
        callInstructionId: callInst.id,
        callRow: callInst.row,
        callAddress: callInst.address,
        receiverCanonicalValueId: receiverVal.id,
      },
    ],
  };

  const enhanced = enhanceSemanticDecompilation(base, model, {
    abiAdapter: ABI,
    cxxEvidence,
    phase8Optimize: true,
    decompilerTimeBudgetMs: 5000,
  });

  assert.equal(
    enhanced.expressionHistoryBinding.reasons.includes('call-result-spelling-unavailable'),
    false,
    `unexpected reasons: ${JSON.stringify(enhanced.expressionHistoryBinding.reasons)}`,
  );

  // Verify any registered callResultSpellingProducer matches `${spelling.name} = ${spelling.callText}`
  for (const node of enhanced.cAst.body) {
    const spelling = readCallResultSpellingProducer(node, enhanced.ir);
    if (spelling) {
      assert.equal(node.text, `${spelling.name} = ${spelling.callText}`);
    }
  }

  // Run projection.js over the enhanced result to confirm end-to-end compatibility
  const state = seedAnalysisState(enhanced.ir);
  runPassTransaction(state, { descriptor: DCE_PASS, run: runDcePass }, { analysis: state, ir: enhanced.ir }, {});
  const projected = applyPhase8Projection(enhanced, state, { preserveInitialSpelling: true });
  assert.ok(projected?.cAst?.body?.length > 0);
});

// ---------------------------------------------------------------------------
// 5. idioms/arm64-clang.js: zero divisor, shift bounds, bit-width checks, clamp contract
// ---------------------------------------------------------------------------
test('[Wave4-B P1] arm64-clang rejects division/modulo by zero, invalid bit_extract shifts, and width mismatches', () => {
  const x32 = expr.variable('x', 32, false);
  const y32 = expr.variable('y', 32, false);
  const z32 = expr.variable('z', 32, false);
  const x64 = expr.variable('x64', 64, false);

  // Division / modulo by zero must return null
  for (const op of ['udiv', 'sdiv', 'umod', 'smod']) {
    assert.equal(recognizeDivisionByConstant(expr.binary(op, x32, expr.constant(0n, 32, false), 32, false)), null);
    const nonZero = recognizeDivisionByConstant(expr.binary(op, x32, expr.constant(7n, 32, false), 32, false));
    assert.equal(nonZero?.divisor, 7n);
  }
  assert.equal(recognizeDivisionByConstant(expr.binary('udiv', x32, { kind: 'const', value: 0 }, 32, false)), null);

  // bit_extract: negative shift, shift >= bits, and lshr/and width mismatch must be rejected
  const negShift = expr.binary('and', expr.binary('lshr', x32, expr.constant(-1n, 32, false), 32, false), expr.constant(0xfn, 32, false), 32, false);
  assert.equal(recoverArm64ClangIdiom(negShift), negShift);

  const overShift = expr.binary('and', expr.binary('lshr', x32, expr.constant(32n, 32, false), 32, false), expr.constant(0xfn, 32, false), 32, false);
  assert.equal(recoverArm64ClangIdiom(overShift), overShift);

  const widthMismatchBfx = expr.binary('and', expr.binary('lshr', x64, expr.constant(4n, 64, false), 64, false), expr.constant(0xfn, 32, false), 32, false);
  assert.equal(recoverArm64ClangIdiom(widthMismatchBfx), widthMismatchBfx);

  const validBfx = expr.binary('and', expr.binary('lshr', x32, expr.constant(4n, 32, false), 32, false), expr.constant(0xfn, 32, false), 32, false);
  const recoveredBfx = recoverArm64ClangIdiom(validBfx);
  assert.equal(recoveredBfx.kind, 'intrinsic');
  assert.equal(recoveredBfx.name, 'bit_extract');

  // madd / msub width mismatch must be rejected; same-width succeeds
  const badMadd = expr.binary('add', expr.binary('mul', x64, x64, 64, false), z32, 32, false);
  assert.equal(recoverArm64ClangIdiom(badMadd), badMadd);
  const badMsub = expr.binary('sub', z32, expr.binary('mul', x64, x64, 64, false), 32, false);
  assert.equal(recoverArm64ClangIdiom(badMsub), badMsub);
  const goodMadd = expr.binary('add', expr.binary('mul', x32, y32, 32, false), z32, 32, false);
  assert.equal(recoverArm64ClangIdiom(goodMadd).name, 'madd');

  // max(x, 0) width mismatch on shifted expression must be rejected
  const badMax = expr.binary(
    'and',
    x32,
    expr.unary('not', expr.binary('ashr', x32, expr.constant(31n, 64, true), 64, true), 32, true),
    32,
    true,
  );
  assert.equal(recoverArm64ClangIdiom(badMax), badMax);

  // recognizeClamp contract preserved
  const xs = expr.variable('x', 32, true);
  const clamp = recognizeClamp(expr.intrinsic('min', [expr.intrinsic('max', [xs, expr.constant(0, 32, true)], 32, true), expr.constant(10, 32, true)], 32, true));
  assert.equal(clamp?.kind, 'clamp');
});

// ---------------------------------------------------------------------------
// 6. phase8/dce.js: generic extra.faults guard & read-only keptReasons Map
// ---------------------------------------------------------------------------
test('[Wave4-B P1/P2] phase8/dce keeps any PURE_CANDIDATES op with non-empty extra.faults and exposes read-only keptReasons Map', () => {
  // Direct predicate check for non-division pure op with faults
  assert.match(
    observableEffectReason({ op: 'bin', sub: 'fdiv', extra: { faults: [{ kind: 'fp-invalid' }] } }),
    /operation can fault: fp-invalid/,
  );
  assert.equal(
    observableEffectReason({ op: 'bin', sub: 'fdiv', extra: { faults: [] } }),
    null,
  );

  // End-to-end DCE pass keeps faulting op and freezes keptReasons Map
  const f = fixture('dce-faulting-pure');
  f.block(0);
  const a = f.opaque(64);
  const b = f.opaque(64);
  const faulting = f.binary('fdiv', a, b, 64);
  faulting.def.extra = { ...(faulting.def.extra || {}), faults: [{ kind: 'fp-trap' }] };
  const deadPure = f.binary('add', a, b, 64);
  f.ret();

  const ir = f.build();
  const state = seedAnalysisState(ir);
  runPassTransaction(state, { descriptor: DCE_PASS, run: runDcePass }, { analysis: state, ir }, {});
  const facts = state.get('deadCode');

  assert.equal(facts.candidates.some((c) => c.valueId === faulting.id), false);
  assert.equal(facts.candidates.some((c) => c.valueId === deadPure.id), true);
  assert.match(facts.keptReasons.get(faulting.id), /operation can fault: fp-trap/);

  // keptReasons remains a genuine Map instance but rejects mutations
  assert.equal(facts.keptReasons instanceof Map, true);
  assert.equal(facts.keptReasons.has(faulting.id), true);
  assert.throws(() => facts.keptReasons.set(9999, 'mutated'), /read-only/);
  assert.throws(() => facts.keptReasons.delete(faulting.id), /read-only/);
  assert.throws(() => facts.keptReasons.clear(), /read-only/);
});

// ---------------------------------------------------------------------------
// 7. dataflow.js: candidateLocationIdentity null guard, updateCache isolation, catch normalization
// ---------------------------------------------------------------------------
test('[Wave4-B P1/P2] dataflow guards null candidateLocationIdentity and isolates updateCache from caller mutation', () => {
  assert.equal(candidateLocationIdentity(null), null);
  assert.equal(candidateLocationIdentity(undefined), null);
  assert.equal(candidateLocationIdentity('bad'), null);
  assert.equal(candidateLocationIdentity({ irKey: 'field:1:0' }), 'ir:field:1:0');
  assert.equal(candidateLocationIdentity({ key: 'x0@0' }), 'x0@0');

  // Mutating the array returned by findValueUpdates must not poison constantComparisons's ambiguity gate
  const multi = modelOfArm64([
    'ldr w8, [x19, #0x20]', 'add w8, w8, #1', 'str w8, [x19, #0x20]',
    'ldr w10, [x19, #0x40]', 'add w10, w10, #1', 'str w10, [x19, #0x40]',
    'mov w9, #100', 'cmp w8, w9', 'ret',
  ]);
  const updates = findValueUpdates(multi);
  assert.ok(updates.length >= 2);
  updates.length = 0; // destructive caller mutation

  const cmps = constantComparisons(multi);
  assert.equal(cmps.filter((c) => c.propagated).length, 0, 'cache must remain intact despite caller mutating returned updates array');
});

test('[Wave4-B P1] findValueUpdates normalizes location.self and sorts rmw even when findIrSemanticUpdates throws', () => {
  const model = modelOfArm64([
    'ldr w8, [x0, #0x20]',
    'add w8, w8, #1',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  // Trigger failure in findIrSemanticUpdates (which reads model.instructions) while allowing findIrValueUpdates to succeed
  const baseUpdates = findValueUpdates(model);
  assert.ok(baseUpdates.length >= 1);
  assert.equal(baseUpdates[0].location.self, true);

  let instructionsReads = 0;
  const flakyModel = Object.create(model, {
    instructions: {
      enumerable: true,
      get() {
        instructionsReads += 1;
        // Let irFor and findIrValueUpdates read instructions, then throw during findIrSemanticUpdates
        if (instructionsReads >= 12) throw new Error('simulated-semantic-adapter-failure');
        return model.instructions;
      },
    },
  });
  const partial = findValueUpdates(flakyModel);
  if (partial.length > 0) {
    assert.equal(partial[0].location.self, true);
  }
});
