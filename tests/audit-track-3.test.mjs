import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { buildValues, render } from '../js/expr.js';
import { decompile as decompileLegacy, decompiledText } from '../js/decompile-legacy.js';
import { knownCallSignature } from '../js/decompiler/call-prototypes.js';
import { parseOperands } from '../js/arm64.js';
import { ARM64_ARCHITECTURE } from '../js/targets/architecture/index.js';
import { buildSemanticV2CompatibilityPipeline, projectSemanticIrV2ToLegacyV1 } from '../js/semantics/compat/index.js';
import { buildIR, setSemanticMigrationMode } from '../js/ir.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../js/semantics/compat/index.js';

function makeModel(rows, opts = {}) {
  const base = opts.base ?? 0x1000n;
  const raw = rows.map((r, row) => ({
    row,
    address: base + BigInt(row * 4),
    mn: r.mn,
    ops: r.ops ?? '',
  }));
  const rowByAddr = new Map(raw.map((r) => [r.address.toString(), r.row]));
  const rowOfAddress = (addr) => rowByAddr.get(BigInt(addr).toString()) ?? null;
  const addrOfRow = (row) => raw[row]?.address ?? null;
  const symbolFor = opts.symbolFor || (() => null);
  const model = buildSemanticModel(raw, {
    startRow: 0,
    endRow: raw.length - 1,
    rowOfAddress,
    addrOfRow,
    symbolFor,
    name: opts.name || 'track3_test_fn',
  });
  if (Array.isArray(opts.addressRefs)) {
    model.addressRefs = [...(model.addressRefs || []), ...opts.addressRefs];
  }
  return { model, rowOfAddress, addrOfRow, symbolFor };
}

test('T3-P0-1: multi-branch v0 join returns initialized v0 and exposes joins/fpValue', () => {
  const { model, rowOfAddress, addrOfRow } = makeModel([
    { mn: 'cbz', ops: 'x0, #0x100c' },      // 0: 0x1000 -> branch to row 3
    { mn: 'fadd', ops: 'd0, d1, d2' },      // 1: 0x1004 (v0 written, not incoming arg)
    { mn: 'b', ops: '#0x1010' },            // 2: 0x1008 -> join at row 4
    { mn: 'fmul', ops: 'd0, d1, d2' },      // 3: 0x100c
    { mn: 'ret', ops: '' },                 // 4: 0x1010
  ]);

  const vg = buildValues(model, { knownCallSignature });
  assert.ok(vg.joins instanceof Map, 'buildValues must expose joins Map');
  assert.ok(vg.joins.has(4), 'join block start row must be present in vg.joins');
  assert.equal(vg.returns.length, 1);
  assert.equal(vg.returns[0].fpValue, null, 'lost v0 at join ret must record fpValue=null');

  const out = decompileLegacy(model, { rowOfAddress, addrOfRow });
  const text = decompiledText(out);
  assert.match(text, /\bv0\s*=/, `branch definitions must assign to v0 (not only v0_1/v0_2); got:\n${text}`);
  assert.doesNotMatch(text, /\bv0_1\s*=/, `lost v0 must not be numbered v0_1 on block-exit defs; got:\n${text}`);
  assert.match(text, /return\s+\(double\)v0;/, `ret must return initialized v0; got:\n${text}`);
});

test('T3-P0-1: single-block v0 return records fpValue and returns matching v0 value', () => {
  const { model, rowOfAddress, addrOfRow } = makeModel([
    { mn: 'fadd', ops: 'd0, d1, d2' },
    { mn: 'ret', ops: '' },
  ]);

  const vg = buildValues(model, { knownCallSignature });
  assert.equal(vg.returns.length, 1);
  assert.ok(vg.returns[0].fpValue, 'single-block ret must record fpValue');
  assert.ok(vg.at(1, 'v0'), 'ret snapshot must record v0 when present in regs');

  const out = decompileLegacy(model, { rowOfAddress, addrOfRow });
  const text = decompiledText(out);
  assert.match(text, /\bv0\s*=\s*a1\s*\+\s*a2;/, `v0 must be assigned; got:\n${text}`);
  assert.match(text, /return\s+\(double\)v0;/, `ret must return v0; got:\n${text}`);
});

test('T3-P0-2: FP-returning call emits to v0, snapshots v0..v7, and expands FP arg expressions with parens', () => {
  const sinAddr = 0x2000n;
  const symbolFor = (addr) => (BigInt(addr) === sinAddr ? '_sin' : null);
  const { model, rowOfAddress, addrOfRow } = makeModel([
    { mn: 'fadd', ops: 'd0, d1, d2' },      // 0: d0 = a1 + a2 (d0 not incoming arg)
    { mn: 'bl', ops: '#0x2000' },           // 1: sin(d0) -> v0
    { mn: 'fadd', ops: 'd0, d0, d3' },      // 2: uses v0 from sin
    { mn: 'ret', ops: '' },                 // 3
  ], { symbolFor });

  const vgDefault = buildValues(model, { symbolFor });
  assert.ok(vgDefault.defAt(1, 'v0'), 'buildValues without explicit knownCallSignature must still emit FP call to v0');
  assert.equal(vgDefault.defAt(1, 'x0'), null, 'buildValues without explicit knownCallSignature must NOT emit FP call to x0');

  const vg = buildValues(model, { symbolFor, knownCallSignature });
  assert.ok(vg.at(1, 'v0'), 'call row snapshot must capture v0');
  assert.ok(vg.defAt(1, 'v0'), 'FP-returning call must emit result to v0');
  assert.equal(vg.defAt(1, 'x0'), null, 'FP-returning call must NOT emit result to x0');

  const out = decompileLegacy(model, { rowOfAddress, addrOfRow, symbolFor });
  const text = decompiledText(out);
  assert.match(text, /\bsin\(\(double\)\(a1 \+ a2\)\)/, `sin() argument must expand expression with parens; got:\n${text}`);
  assert.doesNotMatch(text, /\bx0\s*=\s*sin\(/, `FP-returning call must not assign to x0; got:\n${text}`);
  assert.match(text, /\bv0(?:_\d+)?\s*=.*sin\(/, `FP-returning call result must flow via v0; got:\n${text}`);
});

test('T3-P0-3 & T3-P1-3: cmp preserves op/bits, mi/pl int & fp syntax, unsigned prec 11, nzcvForConstants & minMaxOf guards', () => {
  // 1. Integer mi/pl
  const { model: intMiPl } = makeModel([
    { mn: 'cmp', ops: 'w0, w1' },
    { mn: 'csel', ops: 'w2, w3, w4, mi' },
    { mn: 'csel', ops: 'w5, w3, w4, pl' },
  ]);
  const vgInt = buildValues(intMiPl);
  const miExpr = render(vgInt.defAt(1, 'x2'));
  const plExpr = render(vgInt.defAt(2, 'x5'));
  assert.match(miExpr, /\(\(int32\)\(.* - .*\) < 0\)/, `integer mi must render signed subtraction < 0, got: ${miExpr}`);
  assert.match(plExpr, /\(\(int32\)\(.* - .*\) >= 0\)/, `integer pl must render signed subtraction >= 0, got: ${plExpr}`);

  // 2. FP mi/pl and minMaxOf umin/umax suppression on fcmp
  const { model: fpCmp } = makeModel([
    { mn: 'fcmp', ops: 'd0, d1' },
    { mn: 'csel', ops: 'x2, x3, x4, mi' },
    { mn: 'csel', ops: 'x5, x3, x4, pl' },
    { mn: 'csel', ops: 'd6, d0, d1, lo' },
  ]);
  const vgFp = buildValues(fpCmp);
  const fpMi = render(vgFp.defAt(1, 'x2'));
  const fpPl = render(vgFp.defAt(2, 'x5'));
  assert.match(fpMi, /v0 < v1/, `FP mi must render a < b, got: ${fpMi}`);
  assert.match(fpPl, /!\(v0 < v1\)/, `FP pl must render !(a < b), got: ${fpPl}`);
  const fpLoNode = vgFp.defAt(3, 'v6');
  assert.equal(fpLoNode.k, 'sel', 'fcmp + lo must NOT fold to umin');
  assert.notEqual(fpLoNode.op, 'umin');

  // 3. adds + adc unsigned cast with precedence 11
  const { model: adcModel } = makeModel([
    { mn: 'adds', ops: 'x0, x1, x2' },
    { mn: 'adc', ops: 'x3, x4, x5' },
  ]);
  const vgAdc = buildValues(adcModel);
  const adcText = render(vgAdc.defAt(1, 'x3'));
  assert.match(adcText, /\(uint64\)\(a2 \+ a3\) < \(uint64\)a2/, `adc carry comparison must wrap sum with prec 11 cast, got: ${adcText}`);

  // 4. nzcvForConstants returns null for adcs/sbcs/ngcs with constants
  const { model: constCarryModel } = makeModel([
    { mn: 'mov', ops: 'x1, #1' },
    { mn: 'mov', ops: 'x2, #2' },
    { mn: 'adcs', ops: 'x0, x1, x2' },
    { mn: 'cset', ops: 'x3, eq' },
    { mn: 'sbcs', ops: 'x4, x1, x2' },
    { mn: 'cset', ops: 'x5, lo' },
  ]);
  const vgCarry = buildValues(constCarryModel);
  assert.equal(vgCarry.defAt(3, 'x3')?.k, 'sel', 'adcs with constants must not fold cset to a constant');
  assert.equal(vgCarry.defAt(5, 'x5')?.k, 'sel', 'sbcs with constants must not fold cset to a constant');
});

test('T3-P1-1: variadic printf resolves * as GP and %f as FP (v0..), scanf keeps all args as GP pointers', () => {
  const printfAddr = 0x3000n;
  const sscanfAddr = 0x3100n;
  const symbolFor = (addr) => {
    const a = BigInt(addr);
    if (a === printfAddr) return '_printf';
    if (a === sscanfAddr) return '_sscanf';
    return null;
  };

  // printf("%*.*f %d", w1, w2, d0 + d1, x3)
  const { model: printfModel, rowOfAddress: r1, addrOfRow: a1 } = makeModel([
    { mn: 'adrp', ops: 'x0, #0x4000' },
    { mn: 'add', ops: 'x0, x0, #0x10' },
    { mn: 'fadd', ops: 'd0, d0, d1' },
    { mn: 'bl', ops: '#0x3000' },
    { mn: 'ret', ops: '' },
  ], {
    symbolFor,
    addressRefs: [{ row: 1, addr: 0x4010n, text: '%*.*f %d' }],
  });
  const outPrintf = decompileLegacy(printfModel, { rowOfAddress: r1, addrOfRow: a1, symbolFor });
  const printfText = decompiledText(outPrintf);
  assert.match(printfText, /printf\("%\*\.\*f %d",\s*[^,]+,\s*[^,]+,\s*\(double\)\([^)]+\),\s*[^)]+\)/,
    `printf must route * * to GP, %f to (double)(expr), %d to GP; got:\n${printfText}`);

  // sscanf(x0, "%*s %[a-z] %lf", x2, x3)
  const { model: sscanfModel, rowOfAddress: r2, addrOfRow: a2 } = makeModel([
    { mn: 'adrp', ops: 'x1, #0x4000' },
    { mn: 'add', ops: 'x1, x1, #0x20' },
    { mn: 'bl', ops: '#0x3100' },
    { mn: 'ret', ops: '' },
  ], {
    symbolFor,
    addressRefs: [{ row: 1, addr: 0x4020n, text: '%*s %[a-z] %lf' }],
  });
  const outSscanf = decompileLegacy(sscanfModel, { rowOfAddress: r2, addrOfRow: a2, symbolFor });
  const sscanfText = decompiledText(outSscanf);
  assert.match(sscanfText, /sscanf\([^,]+,\s*"%\*s %\[a-z\] %lf",\s*[^,]+,\s*[^)]+\)/,
    `sscanf must skip %*s, parse scanset, and keep %lf as GP pointer; got:\n${sscanfText}`);
  assert.doesNotMatch(sscanfText, /\(double\)/, `sscanf %lf must not treat arg as FP register; got:\n${sscanfText}`);
});

test('T3-P1-2: augmentLegacyFpSignature recognizes fcvt* consumption of v0 and avoids false x0 consumption on value store', () => {
  // 1. fcvtzs consumes v0 -> return type stays integer, not double
  const { model: fcvtModel, rowOfAddress: r1, addrOfRow: a1 } = makeModel([
    { mn: 'fadd', ops: 'd0, d0, d1' },
    { mn: 'fcvtzs', ops: 'x0, d0' },
    { mn: 'ret', ops: '' },
  ]);
  const outFcvt = decompileLegacy(fcvtModel, { rowOfAddress: r1, addrOfRow: a1 });
  const fcvtText = decompiledText(outFcvt);
  assert.notEqual(outFcvt.types.ret?.type, 'double', 'fcvtzs consuming v0 must not infer double return');
  assert.doesNotMatch(fcvtText, /return\s+\(double\)/, `unexpected double return:\n${fcvtText}`);

  // 2. storing x0 as value (str x0, [x2]) must not mark x0 consumed and steal return type for v0
  const { model: storeX0Model, rowOfAddress: r2, addrOfRow: a2 } = makeModel([
    { mn: 'fadd', ops: 'd0, d0, d1' },
    { mn: 'add', ops: 'x0, x1, #1' },
    { mn: 'str', ops: 'x0, [x2]' },
    { mn: 'ret', ops: '' },
  ]);
  const outStoreX0 = decompileLegacy(storeX0Model, { rowOfAddress: r2, addrOfRow: a2 });
  const storeX0Text = decompiledText(outStoreX0);
  assert.notEqual(outStoreX0.types.ret?.type, 'double', 'str x0, [x2] must not falsely mark x0 consumed');
  assert.doesNotMatch(storeX0Text, /return\s+\(double\)/, `unexpected double return:\n${storeX0Text}`);
});

test('T3-P1-4: post/pre-index writeback on pointer register emits byte-granularity pointer arithmetic', () => {
  const { model, rowOfAddress, addrOfRow } = makeModel([
    { mn: 'ldr', ops: 'd0, [x0], #8' },
    { mn: 'ret', ops: '' },
  ]);
  const out = decompileLegacy(model, { rowOfAddress, addrOfRow });
  const text = decompiledText(out);
  assert.match(text, /\(\s*[^)]*\*\s*\)\(\(uint8_t \*\)a1 \+ 8\)/,
    `post-index writeback on pointer must cast via (uint8_t *); got:\n${text}`);
});

test('T3-P1-5: same-block same-row dominance uses instruction order (later def does not dominate earlier inst)', () => {
  const { model } = makeModel([
    { mn: 'mov', ops: 'x0, #1' },
    { mn: 'bl', ops: '#0x2000' },
    { mn: 'mov', ops: 'x0, #99' },
    { mn: 'ret', ops: '' },
  ]);
  // Map both 0x1004 (bl) and 0x1008 (mov x0, #99) to the exact same row (1)
  const sameRowMap = (addr) => {
    const a = BigInt(addr);
    if (a === 0x1000n) return 0;
    if (a === 0x1004n || a === 0x1008n) return 1;
    if (a === 0x100cn) return 2;
    return null;
  };
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
  try {
    const projected = buildIR(model, { rowOfAddress: sameRowMap });
    const callInst = projected.instructions.find((i) => i.op === 'call');
    assert.ok(callInst, 'call instruction must exist');
    const x0Arg = (callInst.args || []).find((a) => a?.value?.reg === 'x0');
    assert.ok(x0Arg, 'call must bind x0 argument');
    assert.equal(x0Arg.value.const, 1n, 'call at same row as later mov x0, #99 must bind earlier x0=1, not later x0=99');
  } finally {
    setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.AUTO);
  }
});

test('T3-P2-1: attachAbiProjectedArguments 2-pass recomputes graphFacts and resyncs canonicalCfg/isExit/dominators on tail-call BR', () => {
  const symbolFor = (addr) => (BigInt(addr) === 0x2000n ? '_tail_callee' : null);
  const pipeline = buildSemanticV2CompatibilityPipeline({
    architecturePlugin: ARM64_ARCHITECTURE,
    decoderSemanticVersion: 'test-t3-p2-1',
    binaryId: 'bin_t3_p2-1',
    sliceId: 'slice_t3_p2-1',
    addressWidthBits: 64,
    entryBlockKey: 'b0',
    blocks: [
      {
        key: 'b0',
        startAddress: 0x1000n,
        successors: [{ to: 'b1', kind: 'branch' }],
        instructions: [
          { decoded: { address: 0x1000n, mnemonic: 'mov', operands: 'x0, #7', ops: parseOperands('x0, #7'), mode: 'a64' } },
          { decoded: { address: 0x1004n, mnemonic: 'b', operands: '#0x2000', ops: parseOperands('#0x2000'), mode: 'a64' } },
        ],
      },
      {
        key: 'b1',
        startAddress: 0x2000n,
        successors: [],
        instructions: [],
      },
    ],
  }, { symbolFor });

  const projected = projectSemanticIrV2ToLegacyV1(pipeline.semanticIr, {
    ssa: pipeline.semanticSsa,
    memorySsa: pipeline.memorySsa,
    cfg: pipeline.semanticCfg,
    symbolFor,
  });

  assert.equal(projected.blocks[0].succ.length, 0, 'tail-call block succ must be pruned');
  assert.equal(projected.blocks[0].isExit, true, 'tail-call block must be marked isExit=true');
  assert.equal(projected.reachable.has(1), false, 'pruned successor block b1 must no longer be reachable');
  assert.equal(projected.compat.canonicalCfg, false, 'compat.canonicalCfg must be reset to boolean false');
  assert.equal(projected.compat.controlEdges.length, 0, 'compat.controlEdges must reflect pruned edge');
});

test('T3-P2-2: joinInfo call kill set includes v16..v31 so pre-branch v16 does not leak across call join', () => {
  const { model } = makeModel([
    { mn: 'fmov', ops: 'd16, #1.0' },       // 0: 0x1000
    { mn: 'cbz', ops: 'x0, #0x100c' },      // 1: 0x1004 -> join at row 3
    { mn: 'bl', ops: '#0x2000' },           // 2: 0x1008 -> clobbers v16..v31
    { mn: 'fadd', ops: 'd0, d16, d1' },     // 3: 0x100c (join!)
    { mn: 'ret', ops: '' },                 // 4: 0x1010
  ]);

  const vg = buildValues(model);
  const join = vg.joins.get(3);
  assert.ok(join, 'row 3 must be a join point');
  assert.equal(join.all, false);
  assert.ok(join.killed.has('v16'), 'join kill set must include v16');
  assert.ok(join.killed.has('v31'), 'join kill set must include v31');
  const v16AtJoin = vg.at(3, 'v16');
  assert.equal(v16AtJoin?.k, 'reg', 'v16 across call join must be invalidated to reg node, not leaked float 1.0');
});

test('T3-P2-3: needsParens checks balanced outer parens for (a + b) * (c + d)', () => {
  const sinAddr = 0x2000n;
  const symbolFor = (addr) => (BigInt(addr) === sinAddr ? '_sin' : null);
  const { model, rowOfAddress, addrOfRow } = makeModel([
    { mn: 'fadd', ops: 'd4, d0, d1' },      // d4 = a1 + a2
    { mn: 'fadd', ops: 'd5, d2, d3' },      // d5 = a3 + a4
    { mn: 'fmul', ops: 'd0, d4, d5' },      // d0 = (a1 + a2) * (a3 + a4) -> starts with '(' and ends with ')'!
    { mn: 'bl', ops: '#0x2000' },           // sin((double)((a1 + a2) * (a3 + a4)))
    { mn: 'ret', ops: '' },
  ], { symbolFor });

  const out = decompileLegacy(model, { rowOfAddress, addrOfRow, symbolFor });
  const text = decompiledText(out);
  assert.match(text, /sin\(\(double\)\(\([^)]+\)\s*\*\s*\([^)]+\)\)\)/,
    `(a + b) * (c + d) must be wrapped in outer parens for (double) cast; got:\n${text}`);
});
