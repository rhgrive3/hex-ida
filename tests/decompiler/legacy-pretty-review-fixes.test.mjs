import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { buildSemanticModel } from '../../js/blocks.js';
import { decompile as decompileLegacy, decompiledText } from '../../js/decompile-legacy.js';
import { printExpression } from '../../js/decompiler/pretty/c.js';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { buildMemorySsa } from '../../js/semantics/memoryssa/build.js';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';

function makeLegacyModel(lines, opts = {}) {
  const base = opts.addr ?? 0x100000n;
  const rows = lines.map((text, row) => {
    const trimmed = text.trim();
    const split = trimmed.indexOf(' ');
    return {
      row,
      address: base + BigInt(row * 4),
      mn: split < 0 ? trimmed : trimmed.slice(0, split),
      ops: split < 0 ? '' : trimmed.slice(split + 1).trim(),
    };
  });
  const rowOfAddress = (address) => rows.find((r) => r.address === BigInt(address))?.row ?? null;
  const symbols = opts.symbols || new Map();
  const symbolFor = (address) => symbols.get(BigInt(address)) ?? null;
  const model = buildSemanticModel(rows, {
    rowOfAddress,
    symbolFor,
    startRow: 0,
    endRow: rows.length - 1,
  });
  return {
    model,
    opts: {
      addr: base,
      name: opts.name || 'func0',
      symbolFor,
      rowOfAddress,
      beginner: false,
      ...opts,
    },
  };
}

function checkGccSyntax(cCode, label, headers = []) {
  const inc = headers.map((h) => `#include <${h}>`).join('\n');
  const wrapped = `${inc}\n#include <stdint.h>\n#define __asm(x) ((void)0)\ntypedef unsigned long long uint64;\ntypedef long long int64;\ntypedef unsigned int uint32;\ntypedef int int32;\ntypedef unsigned short uint16;\ntypedef short int16;\ntypedef unsigned char uint8;\ntypedef signed char int8;\ntypedef unsigned __int128 uint128;\n${cCode}\n`;
  try {
    execFileSync('gcc', ['-fsyntax-only', '-x', 'c', '-'], {
      input: wrapped,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    assert.fail(`GCC syntax check failed for ${label}:\n${err.stderr?.toString() || err.message}\n--- C ---\n${wrapped}`);
  }
}

test('1. legacy FP return ignores x0 value in ctx.values.returns when ctx.fpReturnReg is set (idx 738/846)', () => {
  // Function takes a pointer in x0 (a1) and a double in d0 (a2), dereferences x0,
  // computes a double result in d0, and returns.
  // ctx.values.returns records x0 (pointer a1), so using `value` would emit `return (double)a1;`
  // causing GCC error "pointer value used where a floating-point was expected".
  const { model, opts } = makeLegacyModel([
    'ldr d1, [x0]',
    'fadd d0, d0, d1',
    'ret',
  ]);
  const res = decompileLegacy(model, opts);
  const code = decompiledText(res);
  assert.match(res.signature, /^double func0\([^,]+ a1, double a2\)$/, `expected pointer a1 + double a2 signature:\n${code}`);
  assert.match(code, /return \(double\)a2;/, `expected FP return from a2 (v0), not pointer a1 (x0):\n${code}`);
  assert.doesNotMatch(code, /return \(double\)a1\b/, `must not cast pointer a1 to double:\n${code}`);
  checkGccSyntax(`uint128 v1;\n${code}`, 'FP return with pointer param in x0');
});

test('2. augmentLegacyFpSignature binds incoming FP registers in ctx.aliases to match signature params', () => {
  // Mixed GP + FP parameters: x0 -> a1, d0 -> a2
  {
    const { model, opts } = makeLegacyModel([
      'ldr x8, [x0]',
      'fadd d0, d0, d0',
      'ret',
    ]);
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(res.signature, /^double func0\([^,]+ a1, double a2\)$/, `unexpected mixed signature:\n${code}`);
    assert.match(code, /return \(double\)a2;/, `expected body return to reference alias a2:\n${code}`);
    assert.doesNotMatch(code, /\bv0\b/, `body must not reference uninitialized v0:\n${code}`);
  }

  // Pure FP 2-arg function: d0 -> a1, d1 -> a2
  {
    const { model, opts } = makeLegacyModel([
      'fadd d0, d0, d1',
      'ret',
    ]);
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.equal(res.signature, 'double func0(double a1, double a2)', `unexpected pure FP signature:\n${code}`);
    assert.match(code, /return \(double\)a1;/, `expected return to reference alias a1:\n${code}`);
    assert.doesNotMatch(code, /\bv0\b/, `body must not reference uninitialized v0:\n${code}`);
    assert.doesNotMatch(code, /\bv1\b/, `body must not reference uninitialized v1:\n${code}`);
    // Compiles cleanly without declaring dummy v0/v1 globals
    checkGccSyntax(`${code}\ndouble caller(void) { return func0(1.0, 2.0); }`, 'pure FP alias binding');
  }
});

test('3. augmentLegacyFpSignature does not misclassify void functions using v0 as scratch or calling bl/blr', () => {
  // v0 written then consumed by str -> void
  {
    const { model, opts } = makeLegacyModel([
      'ldr d0, [x0]',
      'fadd d0, d0, d0',
      'str d0, [x0]',
      'ret',
    ]);
    const res = decompileLegacy(model, opts);
    assert.match(res.signature, /^void func0\(/, `str-consumed v0 must remain void, got: ${res.signature}`);
  }

  // v0 written then consumed by stp -> void
  {
    const { model, opts } = makeLegacyModel([
      'fmov d0, #1.0',
      'fmov d1, #2.0',
      'stp d0, d1, [x0]',
      'ret',
    ]);
    const res = decompileLegacy(model, opts);
    assert.match(res.signature, /^void func0\(/, `stp-consumed v0 must remain void, got: ${res.signature}`);
  }

  // v0 written then consumed by fcmp -> void
  {
    const { model, opts } = makeLegacyModel([
      'ldr d0, [x0]',
      'fcmp d0, #0.0',
      'ret',
    ]);
    const res = decompileLegacy(model, opts);
    assert.match(res.signature, /^void func0\(/, `fcmp-consumed v0 must remain void, got: ${res.signature}`);
  }

  // v0 written then moved into another register (fmov d8, d0) -> void
  {
    const { model, opts } = makeLegacyModel([
      'ldr d0, [x0]',
      'fmov d8, d0',
      'ret',
    ]);
    const res = decompileLegacy(model, opts);
    assert.match(res.signature, /^void func0\(/, `fmov-consumed v0 must remain void, got: ${res.signature}`);
  }

  // v0 written before bl call (clobbers v0) -> stops backward scan, remains void
  {
    const { model, opts } = makeLegacyModel([
      'fmov d0, #1.0',
      'bl #0x200010',
      'ret',
    ], { symbols: new Map([[0x200010n, '_printf']]) });
    const res = decompileLegacy(model, opts);
    assert.match(res.signature, /^void func0\(/, `v0 before bl must not be classified as return, got: ${res.signature}`);
  }

  // v0 written before blr indirect call -> stops backward scan, remains void
  {
    const { model, opts } = makeLegacyModel([
      'fmov d0, #1.0',
      'blr x8',
      'ret',
    ]);
    const res = decompileLegacy(model, opts);
    assert.match(res.signature, /^void func0\(/, `v0 before blr must not be classified as return, got: ${res.signature}`);
  }
});

test('4. mixed GP+FP fixed-arity calls track gpIdx separately so x0 is kept in reads (ldexp, frexp, modf)', () => {
  // ldexp(double x, int exp): arg 0 is d0 (FP), arg 1 is x0 (GP).
  // x0 is loaded from memory (not folded into an immediate), so if x0 is omitted from reads,
  // removeDeadStores would drop the setup assignment to x0.
  for (const [sym, fn] of [['_ldexp', 'ldexp'], ['_frexp', 'frexp'], ['_modf', 'modf']]) {
    const { model, opts } = makeLegacyModel([
      'ldr x0, [x1, #0x8]',
      'add x0, x0, #1',
      'bl #0x200080',
      'ret',
    ], { symbols: new Map([[0x200080n, sym]]) });
    for (const c of model.calls) {
      c.name = sym;
      // Leave raw args empty so normalizeKnownCallArgs resolves GP arg 0 (x0) and FP arg 0 (v0)
      c.args = [];
    }
    const res = decompileLegacy(model, opts);
    const code = decompiledText(res);
    assert.match(code, new RegExp(`\\b${fn}\\(\\(double\\)[^,)]+,\\s*[^,)]+\\)`), `expected 2-arg ${fn} call:\n${code}`);
    // Either x0's computation is preserved as a statement before the call OR inlined into the 2nd argument;
    // it must NOT be dropped as a dead store leaving a bare uninitialized x0.
    const hasSetupStmt = /x0\s*=/.test(code);
    const hasInlinedExpr = new RegExp(`\\b${fn}\\([^,]+,\\s*[^)]*\\+\\s*1\\)`).test(code);
    assert.ok(hasSetupStmt || hasInlinedExpr, `x0 setup before ${fn} was dropped as dead store:\n${code}`);
  }
});

test('5. guardedDivision requires explicit matching width and proven unsignedness in matchesUnsignedVar', () => {
  const u32Known = { kind: 'var', name: 'u', bits: 32, signed: false };
  const u32Known2 = { kind: 'var', name: 'd', bits: 32, signed: false };
  const nullBitsUnsigned = { kind: 'var', name: 'x', bits: null, signed: false };
  const unknownSign32 = { kind: 'var', name: 'y', bits: 32 };
  const signedVar32 = { kind: 'var', name: 's', bits: 32, signed: true };
  const u64Var = { kind: 'var', name: 'w', bits: 64, signed: false };

  // Both operands have explicit matching width (32) and signed === false -> omit redundant casts
  const exactMatch = printExpression({
    kind: 'binary', op: 'udiv', bits: 32, signed: false,
    left: u32Known, right: u32Known2,
  });
  assert.equal(exactMatch, '(uint32_t)(d == 0 ? 0 : u / d)');

  // Operand with bits: null must NOT skip the cast
  const withNullBits = printExpression({
    kind: 'binary', op: 'udiv', bits: 32, signed: false,
    left: nullBitsUnsigned, right: u32Known2,
  });
  assert.match(withNullBits, /\(uint32_t\)x/, `expected explicit cast for bits:null var, got: ${withNullBits}`);

  // Operand with signed: undefined (not proven unsigned) must NOT skip the cast
  const withUnknownSign = printExpression({
    kind: 'binary', op: 'udiv', bits: 32, signed: false,
    left: u32Known, right: unknownSign32,
  });
  assert.match(withUnknownSign, /\(uint32_t\)y/, `expected explicit cast for unknown-sign var, got: ${withUnknownSign}`);

  // Operand with signed: true must NOT skip the cast
  const withSignedVar = printExpression({
    kind: 'binary', op: 'udiv', bits: 32, signed: false,
    left: signedVar32, right: u32Known2,
  });
  assert.match(withSignedVar, /\(uint32_t\)s/, `expected explicit cast for signed var, got: ${withSignedVar}`);

  // Operand with mismatched width (64 in 32-bit udiv) must NOT skip the cast
  const withMismatchedWidth = printExpression({
    kind: 'binary', op: 'udiv', bits: 32, signed: false,
    left: u64Var, right: u32Known2,
  });
  assert.match(withMismatchedWidth, /\(uint32_t\)w/, `expected explicit cast for 64-bit var in 32-bit udiv, got: ${withMismatchedWidth}`);
});

test('6. MemorySSA callMayExposeStackAddress uses nodePosByBlock (O(1) lookup, no findIndex scan)', () => {
  const functionId = 'memoryssa_node_pos_by_block';
  const origin = (id) => ({ instructionIds: [id], virtualRanges: [{ start: 0x1000n, end: 0x1004n }] });
  const spVal = { id: 'sp0', kind: 'entry', machineType: { kind: 'address', widthBits: 64, addressSpace: 'stack' }, sourceEntityId: 'sp', origin: origin('sp0') };
  const storedVal = { id: 'sv0', kind: 'entry', machineType: { kind: 'bitvector', widthBits: 32 }, sourceEntityId: 'sv0', origin: origin('sv0') };
  const loadVal = { id: 'lv0', kind: 'definition', machineType: { kind: 'bitvector', widthBits: 32 }, definitionNodeId: 'load_0', sourceEntityId: 'load_0', origin: origin('lv0') };

  const memory = {
    addressSpace: 'stack',
    addressExpr: { valueId: 'sp0' },
    widthBits: 32,
    endian: 'little',
    alignment: 4,
    volatility: false,
    atomic: false,
    ordering: 'unknown',
    faults: [],
  };

  // Block b0: store stack -> state-write x0 = sp0 -> call_0 (exposes stack via x0) -> load_0 -> ret
  const nodes = [
    { id: 'store_0', kind: 'store', blockId: 'b0', inputs: ['sp0', 'sv0'], outputs: [], memory, origin: origin('store_0') },
    {
      id: 'arg_x0',
      kind: 'state-write',
      blockId: 'b0',
      inputs: ['sp0'],
      outputs: [],
      variable: {
        key: 'reg_x0',
        kind: 'physical-state',
        physicalIdentity: { registerId: 'x0' },
      },
      origin: origin('arg_x0'),
    },
    {
      id: 'call_0',
      kind: 'call',
      blockId: 'b0',
      inputs: [],
      outputs: [],
      call: {
        targetEntityIds: ['helper'],
        arguments: [],
        returns: [],
        memoryRead: { scope: 'all', addressSpaces: ['stack'] },
        memoryWrite: { scope: 'all', addressSpaces: ['stack'] },
        determinism: 'nondeterministic',
        noreturn: false,
        mayThrow: false,
        summarySource: 'test',
        completeness: 'complete',
      },
      origin: origin('call_0'),
    },
    { id: 'load_0', kind: 'load', blockId: 'b0', inputs: ['sp0'], outputs: ['lv0'], memory, origin: origin('load_0') },
    { id: 'ret_0', kind: 'return', blockId: 'b0', inputs: ['lv0'], outputs: [], origin: origin('ret_0') },
  ];

  const ir = createSemanticIrFunction({
    schemaVersion: 2,
    contractVersion: '2.0.0',
    functionId,
    entryBlockId: 'b0',
    blocks: [{ id: 'b0', nodeIds: nodes.map((n) => n.id), origin: origin('b0') }],
    values: [spVal, storedVal, loadVal],
    nodes,
    completeness: 'complete',
    unknowns: [],
    origin: origin('fn'),
  });
  const cfg = createSemanticCfg({ functionId, entryBlockId: 'b0', blocks: [{ id: 'b0', successors: [] }] });
  const region = createMemoryRegionRef({
    id: 'stack_slot_0',
    kind: 'stack-fixed',
    functionId,
    rootEntityId: 'sp',
    offset: 0,
    widthBits: 32,
    origin: origin('stack_slot_0'),
  });

  const blockNodeIds = ir.blocks[0].nodeIds;
  const originalFindIndex = Array.prototype.findIndex;
  let nodeIdsFindIndexCalls = 0;
  Array.prototype.findIndex = function patchedFindIndex(...args) {
    if (this === blockNodeIds) nodeIdsFindIndexCalls += 1;
    return Reflect.apply(originalFindIndex, this, args);
  };
  let memorySsa;
  try {
    memorySsa = buildMemorySsa(ir, cfg, {
      regions: [region],
      resolveRegion() { return region; },
      queryAlias() { return 'must'; },
    });
  } finally {
    Array.prototype.findIndex = originalFindIndex;
  }

  assert.equal(nodeIdsFindIndexCalls, 0, `expected zero findIndex scans on block.nodeIds, got ${nodeIdsFindIndexCalls}`);
  assert.ok(memorySsa && Array.isArray(memorySsa.definitions), 'buildMemorySsa must return valid MemorySSA artifact');
});
