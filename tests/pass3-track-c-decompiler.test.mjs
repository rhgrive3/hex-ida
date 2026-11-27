import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSemanticModel } from '../js/blocks.js';
import { decompile, decompiledText } from '../js/decompile-legacy.js';
import { recoverExactStackPhiExpressions } from '../js/decompiler/passes/stack-phi-recovery.js';
import { expr } from '../js/decompiler/ast/nodes.js';
import { evaluateBinaryFact, fullFact, singletonFact } from '../js/decompiler/phase8/range.js';
import { bitvector } from '../js/decompiler/phase8/bitvector.js';
import { decompileSemantic } from '../js/decompiler/semantic-core.js';
import { MK, OP, VK } from '../js/ir.js';

function makeModel(lines, opts = {}) {
  const raw = lines.map(([mn, ops], index) => ({
    row: index,
    address: 0x1000n + BigInt(index * 4),
    mn,
    ops: ops || '',
  }));
  const rowOfAddress = (addr) => {
    const off = Number(addr - 0x1000n);
    if (off < 0 || off % 4 !== 0) return null;
    const r = off / 4;
    return r >= 0 && r < raw.length ? r : null;
  };
  return buildSemanticModel(raw, {
    name: opts.name || 'test_fn',
    rowOfAddress,
    symbolFor: opts.symbolFor,
    ...opts,
  });
}

test('P3-S04-001: legacy decompiler emits unsigned 32-bit ops and 64-bit widening multiplies', () => {
  const model = makeModel([
    ['udiv', 'w8, w0, w1'],
    ['str', 'w8, [x2, #0]'],
    ['lsr', 'w9, w0, #3'],
    ['str', 'w9, [x2, #4]'],
    ['ror', 'w11, w8, #5'],
    ['str', 'w11, [x2, #12]'],
    ['smull', 'x12, w0, w1'],
    ['str', 'x12, [x2, #24]'],
    ['umull', 'x13, w0, w1'],
    ['str', 'x13, [x2, #32]'],
    ['ret', ''],
  ]);
  const text = decompiledText(decompile(model, { useSemantic: false }));

  assert.match(text, /\(uint32\)\S+ \/ \(uint32\)\S+/, `udiv should use uint32 operands:\n${text}`);
  assert.match(text, /\(uint32\)\S+ >> 3/, `lsr should use uint32 operand:\n${text}`);
  assert.match(text, /\(uint32\)\(\S+\) >> \(5 & 31\)/, `32-bit ror should use uint32 and 32-bit mask:\n${text}`);
  assert.match(text, /\(int64\)\(int32\)\S+ \* \(int64\)\(int32\)\S+/, `smull should widen to int64:\n${text}`);
  assert.match(text, /\(uint64\)\(uint32\)\S+ \* \(uint64\)\(uint32\)\S+/, `umull should widen to uint64:\n${text}`);
});

test('P3-S04-002: legacy decompiler respects destination width and source signedness on FP conversions', () => {
  const model = makeModel([
    ['fcvt', 's1, d0'],
    ['scvtf', 's2, w0'],
    ['ucvtf', 's3, w1'],
    ['ucvtf', 'd4, x2'],
    ['fcvtzs', 'w8, s1'],
    ['fcvtzu', 'w9, d4'],
    ['add', 'w0, w8, w9'],
    ['fadd', 's0, s2, s3'],
    ['ret', ''],
  ]);
  const text = decompiledText(decompile(model, { useSemantic: false }));

  assert.match(text, /=\s*\(float\)/, `fcvt s1, d0 / scvtf s2, w0 should emit (float):\n${text}`);
  assert.match(text, /\(float\)\(int32\)/, `scvtf s2, w0 should cast to (float)(int32):\n${text}`);
  assert.match(text, /\(float\)\(uint32\)/, `ucvtf s3, w1 should cast to (float)(uint32):\n${text}`);
  assert.match(text, /\(double\)\(uint64\)/, `ucvtf d4, x2 should cast to (double)(uint64):\n${text}`);
  assert.match(text, /\(int32\)/, `fcvtzs w8, s1 should cast to (int32):\n${text}`);
  assert.match(text, /\(uint32\)/, `fcvtzu w9, d4 should cast to (uint32):\n${text}`);
  assert.doesNotMatch(text, /\(int64\)v1|\(uint64\)v4/, `32-bit fcvtzs/fcvtzu must not widen to int64/uint64:\n${text}`);
});

test('P3-S04-003: Objective-C tail call emits return and ctrl kind in default bracket syntax', () => {
  const targetAddr = 0x2000n;
  const nonVoidModel = makeModel([
    ['mov', 'x0, x1'],
    ['b', '#0x2000'],
  ], {
    name: '-[Foo bar]',
    symbolFor: (addr) => (addr === targetAddr ? '_objc_msgSend$doWork:' : null),
  });
  const res = decompile(nonVoidModel, { useSemantic: false });
  const text = decompiledText(res);
  assert.match(text, /return \[\S+ doWork:/, `ObjC tail call in default syntax should emit return:\n${text}`);
  const tailLine = res.lines.find((l) => /return \[/.test(l.text));
  assert.ok(tailLine, 'expected a return line for ObjC tail call');
  assert.equal(tailLine.kind, 'ctrl');

  const voidModel = makeModel([
    ['b', '#0x2000'],
  ], {
    name: '-[Foo baz]',
    symbolFor: (addr) => (addr === targetAddr ? '_objc_msgSend$doWork:' : null),
  });
  const voidRes = decompile(voidModel, { useSemantic: false });
  const voidText = decompiledText(voidRes);
  assert.match(voidText, /\[\S+ doWork:[^\]]*\]; return;/, `void caller ObjC tail call should terminate with return;:\n${voidText}`);
  const voidTailLine = voidRes.lines.find((l) => /\]; return;/.test(l.text));
  assert.ok(voidTailLine, 'expected a void return line for ObjC tail call');
  assert.equal(voidTailLine.kind, 'ctrl');
});

test('P3-S04-004: stack-phi-recovery treats non-stack pointer stores as barriers while allowing non-aliasing global stores', () => {
  function makeScenario(interveningLoc) {
    const valArg = { id: 1, kind: VK.ARG, reg: 'x0', bits: 64, signed: false, def: null, uses: [] };
    const valWrite = { id: 2, kind: VK.ARG, reg: 'x1', bits: 64, signed: false, def: null, uses: [] };
    const valLoad = { id: 3, kind: VK.DEF, reg: 'x0', version: 1, bits: 64, signed: false, def: null, uses: [] };

    const stackLoc = { kind: MK.STACK, key: 'stack:sp:c16:s8', baseReg: 'sp', frameEpoch: 0, disp: 16n, size: 8 };
    const storeSlot = {
      id: 10, op: OP.STORE, block: 0, row: 1, address: 0x1004n,
      args: [{ value: valArg, bits: 64 }],
      loc: stackLoc,
      size: 8,
    };
    const middleStore = {
      id: 11, op: OP.STORE, block: 0, row: 2, address: 0x1008n,
      args: [{ value: valWrite, bits: 64 }],
      loc: interveningLoc,
      size: 8,
    };
    const loadSlot = {
      id: 12, op: OP.LOAD, block: 0, row: 3, address: 0x100cn,
      dst: valLoad,
      args: [],
      loc: stackLoc,
      size: 8,
    };
    valLoad.def = loadSlot;
    const ret = {
      id: 13, op: OP.RET, block: 0, row: 4, address: 0x1010n,
      args: [{ value: valLoad, bits: 64 }],
    };

    const insts = [storeSlot, middleStore, loadSlot, ret];
    const block0 = {
      index: 0, id: 0, startRow: 0, endRow: 4, address: 0x1000n,
      insts, phis: [], pred: [], succ: [], idom: -1,
    };
    const loadExpr = expr.load(
      { kind: 'stack', key: 'stack:sp:c16:s8', size: 8 },
      64,
      { ir: [loadSlot.id], rows: [loadSlot.row], addresses: [loadSlot.address] },
    );
    const ir = {
      entry: 0,
      blocks: [block0],
      instructions: insts,
      values: [valArg, valWrite, valLoad],
      idom: [-1],
      dominators: [new Set([0])],
    };
    const semanticAst = {
      values: [
        { valueId: valArg.id, expression: expr.variable('a1', 64, false) },
        { valueId: valWrite.id, expression: expr.variable('a2', 64, false) },
        { valueId: valLoad.id, expression: loadExpr },
      ],
      conditions: [],
      stores: [],
      outputs: [{ name: 'return', expression: loadExpr }],
    };
    const cAst = {
      header: 'uint64_t test_fn(uint64_t a1, uint64_t a2) {',
      footer: '}',
      body: [
        {
          kind: 'stmt', indent: 1, text: 'return local_16;',
          row: ret.row, addr: ret.address,
          source: { ir: [ret.id], rows: [ret.row], addresses: [ret.address] },
          semantic: { op: 'return', ir: ret.id, expression: loadExpr },
        },
      ],
    };
    return { semantic: true, ir, semanticAst, cAst, lines: [], pseudocode: '' };
  }

  // Case 1: non-stack field/pointer store (*p = a2) may alias stack slot -> must block recovery.
  const fieldScenario = makeScenario({ kind: MK.FIELD, key: 'field:arg:x0+0:s8', disp: 0n, size: 8 });
  recoverExactStackPhiExpressions(fieldScenario);
  assert.equal(fieldScenario.cAst.body[0].text, 'return local_16;', 'non-stack pointer store must block stale stack forwarding');

  // Case 2: global store cannot alias a stack slot -> recovery still forwards a1.
  const globalScenario = makeScenario({ kind: MK.GLOBAL, key: 'global:10008000:s8', address: 0x10008000n, size: 8 });
  recoverExactStackPhiExpressions(globalScenario);
  assert.equal(globalScenario.cAst.body[0].text, 'return a1;', 'non-aliasing global store should not block stack recovery');
});

test('P3-S05-001: phase8 range evaluateBinaryFact interprets negative pointer displacements as signed', () => {
  const ptrFact = fullFact(64, {
    valueId: 1,
    pointerOffset: { baseId: 'sp', offset: 0n },
    alignment: { modulus: 16n, remainder: 0n },
    provenance: {
      pointer: true,
      valueId: 1,
      pointerBaseId: 'sp',
      addressDomain: 'stack',
      instructionIds: ['ptr-1'],
    },
  });
  const neg16 = singletonFact(bitvector(0xfffffffffffffff0n, 64));

  const added = evaluateBinaryFact('add', ptrFact, neg16);
  assert.equal(added.pointerOffset?.baseId, 'sp');
  assert.equal(added.pointerOffset?.offset, -16n);

  const subbed = evaluateBinaryFact('sub', ptrFact, neg16);
  assert.equal(subbed.pointerOffset?.baseId, 'sp');
  assert.equal(subbed.pointerOffset?.offset, 16n);

  // Commutative add: (-16) + ptr
  const commAdded = evaluateBinaryFact('add', neg16, ptrFact);
  assert.equal(commAdded.pointerOffset?.baseId, 'sp');
  assert.equal(commAdded.pointerOffset?.offset, -16n);
});

test('P3-S05-002: semantic-core detects AArch64 s0/d0/v0 return register clobbers before ret', () => {
  const preCallVal = { id: 1, kind: VK.DEF, reg: 'd0', version: 1, bits: 64, uses: [], const: null };
  const postCallVal = { id: 2, kind: VK.DEF, reg: 'v0', version: 2, bits: 64, uses: [], const: null };
  const defPre = { id: 10, op: OP.CONST, block: 0, row: 0, dst: preCallVal, args: [], extra: { value: 1n } };
  preCallVal.def = defPre;
  const callInst = {
    id: 11,
    op: OP.CALL,
    block: 0,
    row: 1,
    dst: postCallVal,
    args: [],
    clobbers: ['x0', 'v0'],
    extra: { target: 0x3000n, clobbers: ['x0', 'v0'] },
  };
  postCallVal.def = callInst;
  const retInst = {
    id: 12,
    op: OP.RET,
    block: 0,
    row: 2,
    args: [{ value: preCallVal }],
    extra: { returnReg: 'v0', returnRegs: ['v0'], returnBits: 64 },
  };
  preCallVal.uses.push(retInst);

  const ir = {
    name: 'fp_clobber_test',
    entry: 0,
    architecture: 'arm64',
    blocks: [
      { index: 0, pred: [], succ: [], insts: [defPre, callInst, retInst], phis: [], memPhis: [], isEntry: true, isExit: true },
    ],
    instructions: [defPre, callInst, retInst],
    values: [preCallVal, postCallVal],
    args: new Map(),
    locations: new Map(),
    byRow: new Map([[0, [defPre]], [1, [callInst]], [2, [retInst]]]),
    stackSlots: [],
  };

  const model = makeModel([
    ['fmov', 'd0, #1.0'],
    ['bl', '#0x3000'],
    ['ret', ''],
  ], {
    name: 'fp_clobber_test',
    symbolFor: (addr) => (addr === 0x3000n ? '_compute_double' : null),
  });

  const out = decompileSemantic(model, {
    ir,
    architecture: 'arm64',
    returnType: 'double',
    returnClass: 'fp',
    returnBits: 64,
    symbolFor: (addr) => (addr === 0x3000n ? '_compute_double' : null),
  });
  const text = out.lines.map((l) => l.text).join('\n');
  assert.match(text, /return\s+(?:_?compute_double\(|[a-zA-Z0-9_]+\s*;)/, `expected return of post-call value:\n${text}`);
  assert.doesNotMatch(text, /return\s+1\b/, `must not return stale pre-call d0 constant 1:\n${text}`);
});
