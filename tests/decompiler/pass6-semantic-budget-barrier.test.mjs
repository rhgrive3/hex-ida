import assert from 'node:assert/strict';
import test from 'node:test';
import { decompileSemantic, renderValue } from '../../js/decompiler/semantic-core.js';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR, OP, VK, MK, COND } from '../../js/ir.js';

function makeMinimalRenderCtx(opts = {}, model = { addressRefs: [] }) {
  return {
    ir: { instructions: [], values: [], blocks: [] },
    model,
    opts,
    types: { values: new Map() },
    exprCache: new Map(),
    exprActive: new Set(),
    exprNodes: 0,
    materialNames: new Map(),
    callCache: new Map(),
    unknownCallArities: 0,
  };
}

function makeIRBuilder(name = 'test_fn') {
  let nextValId = 1;
  let nextInstId = 1;
  const values = [];
  const instructions = [];
  const blocks = [];
  const blockMap = new Map();

  function block(index, succ = []) {
    if (!blockMap.has(index)) {
      const b = { index, startRow: index * 10, endRow: index * 10 + 9, succ: [...succ], insts: [] };
      blockMap.set(index, b);
      blocks.push(b);
    } else if (succ.length) {
      blockMap.get(index).succ = [...succ];
    }
    return blockMap.get(index);
  }

  function makeVal({ kind = VK.REG, bits = 32, signed = true, reg = null, constVal = null } = {}) {
    const v = {
      id: nextValId++,
      kind,
      bits,
      signed,
      reg,
      const: constVal,
      def: null,
      uses: [],
    };
    values.push(v);
    return v;
  }

  function addInst(blockIndex, row, fields) {
    const b = block(blockIndex);
    const inst = {
      id: nextInstId++,
      block: blockIndex,
      row,
      address: 0x1000n + BigInt(row * 4),
      ...fields,
    };
    if (inst.dst) inst.dst.def = inst;
    for (const arg of inst.args || []) {
      if (arg?.value) arg.value.uses.push(inst);
    }
    for (const inc of inst.incoming || []) {
      if (inc?.value) inc.value.uses.push(inst);
    }
    if (inst.loc?.base) inst.loc.base.uses.push(inst);
    if (inst.loc?.index) inst.loc.index.uses.push(inst);
    instructions.push(inst);
    b.insts.push(inst);
    return inst;
  }

  function build() {
    blocks.sort((a, b) => a.index - b.index);
    const ir = {
      name,
      entry: blocks[0]?.index ?? 0,
      blocks,
      instructions,
      values,
    };
    const model = {
      name,
      instructions: instructions.map((i) => ({ row: i.row, address: i.address })),
      calls: [],
      addressRefs: [],
      switches: [],
    };
    return { ir, model };
  }

  return { block, makeVal, addInst, build };
}

// ============================================================================
// 1. ctx.exprNodes reset across >600 sequential renderValue calls (idx = 734)
// ============================================================================

test('1a. renderValue resets ctx.exprNodes per top-level expression across >600 calls', () => {
  const ctx = makeMinimalRenderCtx();
  const arg0 = { id: 1, kind: VK.ARG, bits: 32, signed: true, reg: 'w0', argIndex: 0, def: null, uses: [] };

  for (let i = 1; i <= 650; i++) {
    const c = { id: 1000 + i * 2, kind: VK.CONST, bits: 32, signed: true, const: BigInt(i), def: null, uses: [] };
    const sum = { id: 1000 + i * 2 + 1, kind: VK.REG, bits: 32, signed: true, reg: 'w1', def: null, uses: [] };
    sum.def = {
      id: i,
      row: i,
      block: 0,
      op: OP.BIN,
      sub: 'add',
      dst: sum,
      args: [{ value: arg0 }, { value: c }],
    };
    const text = renderValue(sum, ctx);
    const expectedNum = i >= 100 ? `0x${i.toString(16).toUpperCase()}` : String(i);
    assert.equal(text, `w0 + ${expectedNum}`, `call #${i} degraded instead of rendering expression`);
    assert.equal(ctx.exprNodes, 0, `ctx.exprNodes should reset after top-level call #${i}`);
  }
});

test('1b. a single oversized expression tree hits bounded-fallback without poisoning subsequent expressions', () => {
  const ctx = makeMinimalRenderCtx();
  // Build a binary chain of depth 600 (> MAX_EXPR_NODES = 512)
  let cur = { id: 1, kind: VK.ARG, bits: 32, signed: true, reg: 'w0', argIndex: 0, def: null, uses: [] };
  for (let i = 0; i < 600; i++) {
    const c1 = { id: 2 + i * 2, kind: VK.CONST, bits: 32, signed: true, const: 1n, def: null, uses: [] };
    const next = { id: 3 + i * 2, kind: VK.REG, bits: 32, signed: true, reg: 'w2', def: null, uses: [] };
    next.def = {
      id: i + 1,
      row: i + 1,
      block: 0,
      op: OP.BIN,
      sub: 'add',
      dst: next,
      args: [{ value: cur }, { value: c1 }],
    };
    cur = next;
  }

  const huge = renderValue(cur, ctx);
  assert.match(huge, /\bw2\b/, 'oversized expression should still bound itself via fallback');
  assert.equal(ctx.exprNodes, 0, 'ctx.exprNodes must reset after oversized top-level expression');

  // Subsequent expression must render cleanly, not degrade to bounded-fallback
  const c42 = { id: 9001, kind: VK.CONST, bits: 32, signed: true, const: 42n, def: null, uses: [] };
  const after = { id: 9002, kind: VK.REG, bits: 32, signed: true, reg: 'w3', def: null, uses: [] };
  after.def = {
    id: 9002,
    row: 9002,
    block: 0,
    op: OP.CONST,
    dst: after,
    args: [],
    extra: { value: 42n },
  };
  assert.equal(renderValue(c42, ctx), '42');
  assert.equal(renderValue(after, ctx), '42');
  assert.equal(ctx.exprNodes, 0);
});

// ============================================================================
// 2. OP.LOAD materialization across aliasing OP.STORE (idx = 1074, 1150)
// ============================================================================

test('2a. same-block swap materializes load before aliasing store (idx 1074 pattern)', () => {
  const b = makeIRBuilder('swap_pair');
  b.block(0, []);
  const ptr = b.makeVal({ kind: VK.ARG, bits: 64, signed: false, reg: 'x0' });
  ptr.argIndex = 0;

  const vA = b.makeVal({ bits: 32, signed: true, reg: 'w1' });
  const vB = b.makeVal({ bits: 32, signed: true, reg: 'w2' });

  const loc0 = { kind: MK.FIELD, base: ptr, disp: 0n, size: 4 };
  const loc4 = { kind: MK.FIELD, base: ptr, disp: 4n, size: 4 };

  b.addInst(0, 0, { op: OP.LOAD, dst: vA, loc: loc0, args: [] });
  b.addInst(0, 1, { op: OP.LOAD, dst: vB, loc: loc4, args: [] });
  b.addInst(0, 2, { op: OP.STORE, loc: loc0, args: [{ value: vB }] });
  b.addInst(0, 3, { op: OP.STORE, loc: loc4, args: [{ value: vA }] });
  b.addInst(0, 4, { op: OP.RET, args: [{ value: vA }] });

  const { ir, model } = b.build();
  const res = decompileSemantic(model, { ir, name: 'swap_pair' });
  assert.ok(res, 'decompileSemantic returned null');
  assert.match(
    res.pseudocode,
    new RegExp(`\\bload_${vA.id}\\b`),
    `first loaded element must be materialized before aliasing store:\n${res.pseudocode}`,
  );
});

test('2b. same-block loop back-edge (ui <= di) with aliasing store materializes load', () => {
  const b = makeIRBuilder('self_loop_load_store');
  b.block(0, [1]);
  b.block(1, [1, 2]);
  b.block(2, []);

  const ptr = b.makeVal({ kind: VK.ARG, bits: 64, signed: false, reg: 'x0' });
  ptr.argIndex = 0;
  const initVal = b.makeVal({ kind: VK.CONST, bits: 32, signed: true, constVal: 0n });
  const c1 = b.makeVal({ kind: VK.CONST, bits: 32, signed: true, constVal: 1n });
  const c10 = b.makeVal({ kind: VK.CONST, bits: 32, signed: true, constVal: 10n });

  const phiVal = b.makeVal({ bits: 32, signed: true, reg: 'w1' });
  const vLoad = b.makeVal({ bits: 32, signed: true, reg: 'w2' });
  const vNext = b.makeVal({ bits: 32, signed: true, reg: 'w3' });
  const flags = b.makeVal({ bits: 32, signed: false, reg: 'nzcv' });

  const loc0 = { kind: MK.FIELD, base: ptr, disp: 0n, size: 4 };

  b.addInst(0, 0, { op: OP.JMP, args: [], extra: { targetBlock: 1 } });
  // In block 1: PHI at row 10 (ui < di) consumes vLoad defined at row 11 (di),
  // followed by an aliasing STORE at row 12 before the back-edge to block 1!
  b.addInst(1, 10, {
    op: OP.PHI,
    dst: phiVal,
    incoming: [{ from: 0, value: initVal }, { from: 1, value: vLoad }],
    args: [],
  });
  b.addInst(1, 11, { op: OP.LOAD, dst: vLoad, loc: loc0, args: [] });
  b.addInst(1, 12, { op: OP.BIN, sub: 'add', dst: vNext, args: [{ value: phiVal }, { value: c1 }] });
  b.addInst(1, 13, { op: OP.STORE, loc: loc0, args: [{ value: vNext }] });
  b.addInst(1, 14, { op: OP.CMP, dst: flags, args: [{ value: vNext }, { value: c10 }] });
  b.addInst(1, 15, { op: OP.CBR, cond: COND.LT, args: [{ value: flags }], extra: { targetBlock: 1 } });
  b.addInst(2, 20, { op: OP.RET, args: [{ value: phiVal }] });

  const { ir, model } = b.build();
  const res = decompileSemantic(model, { ir, name: 'self_loop_load_store' });
  assert.ok(res, 'decompileSemantic returned null');
  assert.match(
    res.pseudocode,
    new RegExp(`\\bload_${vLoad.id}\\b`),
    `load feeding loop back-edge across aliasing store must be materialized:\n${res.pseudocode}`,
  );
});

test('2c. cross-block use with ui <= di (consumer block ordered before def block) materializes load (idx 1150 pattern)', () => {
  const b = makeIRBuilder('insertion_sort_key');
  b.block(0, [2]);
  b.block(1, [3]);
  b.block(2, [1]);
  b.block(3, []);

  const ptr = b.makeVal({ kind: VK.ARG, bits: 64, signed: false, reg: 'x0' });
  ptr.argIndex = 0;
  const c99 = b.makeVal({ kind: VK.CONST, bits: 32, signed: true, constVal: 99n });
  const vKey = b.makeVal({ bits: 32, signed: true, reg: 'w1' });

  const loc0 = { kind: MK.FIELD, base: ptr, disp: 0n, size: 4 };
  const loc4 = { kind: MK.FIELD, base: ptr, disp: 4n, size: 4 };

  // Emit block 1 instructions BEFORE block 2 in ir.instructions so ui < di!
  b.addInst(0, 0, { op: OP.JMP, args: [], extra: { targetBlock: 2 } });
  b.addInst(1, 10, { op: OP.STORE, loc: loc0, args: [{ value: c99 }] });
  b.addInst(1, 11, { op: OP.STORE, loc: loc4, args: [{ value: vKey }] });
  b.addInst(1, 12, { op: OP.JMP, args: [], extra: { targetBlock: 3 } });
  // Block 2 defines vKey at higher instruction index than block 1's use!
  b.addInst(2, 20, { op: OP.LOAD, dst: vKey, loc: loc0, args: [] });
  b.addInst(2, 21, { op: OP.JMP, args: [], extra: { targetBlock: 1 } });
  b.addInst(3, 30, { op: OP.RET, args: [{ value: c99 }] });

  const { ir, model } = b.build();
  const res = decompileSemantic(model, { ir, name: 'insertion_sort_key' });
  assert.ok(res, 'decompileSemantic returned null');
  assert.match(
    res.pseudocode,
    new RegExp(`\\bload_${vKey.id}\\b`),
    `cross-block load with ui <= di must be materialized:\n${res.pseudocode}`,
  );
});

test('2d. same-block non-aliasing stack store does not unnecessarily materialize load', () => {
  const b = makeIRBuilder('disjoint_stack');
  b.block(0, []);
  const v1 = b.makeVal({ bits: 32, signed: true, reg: 'w1' });
  const c7 = b.makeVal({ kind: VK.CONST, bits: 32, signed: true, constVal: 7n });

  b.addInst(0, 0, { op: OP.LOAD, dst: v1, loc: { kind: MK.STACK, disp: 0n, size: 4 }, args: [] });
  b.addInst(0, 1, { op: OP.STORE, loc: { kind: MK.STACK, disp: 16n, size: 4 }, args: [{ value: c7 }] });
  b.addInst(0, 2, { op: OP.RET, args: [{ value: v1 }] });

  const { ir, model } = b.build();
  const res = decompileSemantic(model, { ir, name: 'disjoint_stack' });
  assert.ok(res);
  assert.doesNotMatch(
    res.pseudocode,
    new RegExp(`\\bload_${v1.id}\\b`),
    `non-aliasing stack store should not force materialization:\n${res.pseudocode}`,
  );
});

// ============================================================================
// 3. Short .rodata string literal resolution ("-1", "NO", "YES", "No", "Yes")
// ============================================================================

test('3a. folded adrp+add address constant resolves short strings via opts.stringFor when model.addressRefs has row+addr proof', () => {
  const shortStrings = ['-1', 'NO', 'YES', 'No', 'Yes'];
  for (let i = 0; i < shortStrings.length; i++) {
    const text = shortStrings[i];
    const targetAddr = 0x401000n + BigInt(i * 4);
    const rows = [
      { row: 0, address: 0x400100n, mn: 'adrp', ops: 'x0, #0x401000' },
      { row: 1, address: 0x400104n, mn: 'add', ops: `x0, x0, #0x${(i * 4).toString(16)}` },
      { row: 2, address: 0x400108n, mn: 'ret', ops: '' },
    ];
    const rowOfAddress = (a) => rows.find((r) => r.address === BigInt(a))?.row ?? null;
    const model = buildSemanticModel(rows, { rowOfAddress, startRow: 0, endRow: 2 });
    const ir = buildIR(model, { rowOfAddress, returnType: 'ptr', semanticMigrationMode: 'semantic-v2-compat' });
    const res = decompileSemantic(model, {
      ir,
      rowOfAddress,
      stringFor: (addr) => (BigInt(addr) === targetAddr ? text : null),
    });
    assert.ok(res, `decompileSemantic failed for ${text}`);
    assert.match(
      res.pseudocode,
      new RegExp(`return ${JSON.stringify(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')};`),
      `expected folded adrp+add to resolve ${JSON.stringify(text)}, got:\n${res.pseudocode}`,
    );
  }
});

test('3b. folded OP.ADDR + OP.BIN(add) resolves short 1-3 byte strings from .rodata section bytes', () => {
  const rodata = new Uint8Array(64);
  const entries = [
    [0, '-1'],
    [8, 'NO'],
    [16, 'YES'],
    [24, 'No'],
    [32, 'Yes'],
  ];
  for (const [off, str] of entries) {
    for (let i = 0; i < str.length; i++) rodata[off + i] = str.charCodeAt(i);
    rodata[off + str.length] = 0;
  }
  const section = { name: '.rodata', addr: 0x401000n, size: 64n, bytes: rodata };

  for (const [off, str] of entries) {
    const ctx = makeMinimalRenderCtx({ sections: [section] });
    const pageVal = { id: 1, kind: VK.REG, bits: 64, signed: false, const: 0x401000n, def: null, uses: [] };
    pageVal.def = { id: 1, row: 0, block: 0, op: OP.ADDR, dst: pageVal, args: [], extra: { value: 0x401000n } };
    const offVal = { id: 2, kind: VK.CONST, bits: 64, signed: false, const: BigInt(off), def: null, uses: [] };
    const folded = { id: 3, kind: VK.REG, bits: 64, signed: false, const: 0x401000n + BigInt(off), def: null, uses: [] };
    folded.def = { id: 2, row: 1, block: 0, op: OP.BIN, sub: 'add', dst: folded, args: [{ value: pageVal }, { value: offVal }] };

    assert.equal(renderValue(folded, ctx), JSON.stringify(str), `expected .rodata short string ${JSON.stringify(str)}`);
  }
});

test('3c. plain numeric OP.CONST without addressRef proof does not invoke opts.stringFor', () => {
  let calls = 0;
  const ctx = makeMinimalRenderCtx({
    stringFor: () => {
      calls++;
      return 'YES';
    },
  });
  const numVal = { id: 10, kind: VK.REG, bits: 64, signed: false, const: 0x401000n, def: null, uses: [] };
  numVal.def = { id: 1, row: 0, block: 0, op: OP.CONST, dst: numVal, args: [], extra: { value: 0x401000n } };

  const out = renderValue(numVal, ctx);
  assert.notEqual(out, '"YES"');
  assert.equal(calls, 0, 'plain numeric constant must not query opts.stringFor');
});
