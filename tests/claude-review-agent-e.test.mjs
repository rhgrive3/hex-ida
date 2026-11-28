import test from 'node:test';
import { parseDebugInfo, extractFunctionPrototypes } from '../js/analysis/debug/dwarf.js';
import assert from 'node:assert/strict';

import { analysisFromBinaryImage } from '../js/platform/analysis-result.js';
import { SymbolIndex } from '../js/symbols.js';
import { decompile } from '../js/decompile.js';
import { wasmDecompileArm64Function } from '../js/core/hex-engine-bridge.js';

// ---------------------------------------------------------------------------
// Minimal DWARF4 builder for unit tests
// ---------------------------------------------------------------------------
function u16le(v) { return [v & 0xff, (v >> 8) & 0xff]; }
function u32le(v) { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]; }
function u64le(v) {
  const b = BigInt(v);
  const out = [];
  for (let i = 0; i < 8; i += 1) out.push(Number((b >> BigInt(i * 8)) & 0xffn));
  return out;
}
function cstr(s) { return [...Buffer.from(s, 'utf8'), 0]; }

function buildMinimalDwarf4({ fnAddr = 0x1000n, fnName = 'identity_int', retTypeName = 'int', paramName = 'x', paramTypeName = 'int' } = {}) {
  // Abbrev table:
  // 1: DW_TAG_compile_unit (0x11), has_children=1, no attrs
  // 2: DW_TAG_base_type (0x24), has_children=0, DW_AT_name (0x03, string 0x08), DW_AT_byte_size (0x0b, data1 0x0b), DW_AT_encoding (0x3e, data1 0x0b)
  // 3: DW_TAG_subprogram (0x2e), has_children=1, DW_AT_name (0x03, string 0x08), DW_AT_low_pc (0x11, addr 0x01), DW_AT_type (0x49, ref4 0x13)
  // 4: DW_TAG_formal_parameter (0x05), has_children=0, DW_AT_name (0x03, string 0x08), DW_AT_type (0x49, ref4 0x13)
  const debug_abbrev = new Uint8Array([
    1, 0x11, 1, 0, 0,
    2, 0x24, 0, 0x03, 0x08, 0x0b, 0x0b, 0x3e, 0x0b, 0, 0,
    3, 0x2e, 1, 0x03, 0x08, 0x11, 0x01, 0x49, 0x13, 0, 0,
    4, 0x05, 0, 0x03, 0x08, 0x49, 0x13, 0, 0,
    0,
  ]);

  // Build CU body (header is 11 bytes: unit_length(4) + version(2) + abbrev_off(4) + addr_size(1))
  const body = [];
  // DIE 1: compile_unit (offset 11)
  body.push(1);
  // DIE 2: ret base_type
  const retTypeOff = 11 + body.length;
  body.push(2, ...cstr(retTypeName), 4, 5); // DW_ATE_signed = 5
  // DIE 3: param base_type (if different)
  let paramTypeOff = retTypeOff;
  if (paramTypeName !== retTypeName) {
    paramTypeOff = 11 + body.length;
    body.push(2, ...cstr(paramTypeName), 4, 5);
  }
  // DIE 4: subprogram
  body.push(3, ...cstr(fnName), ...u64le(fnAddr), ...u32le(retTypeOff));
  // Child: formal_parameter
  body.push(4, ...cstr(paramName), ...u32le(paramTypeOff));
  // End children of subprogram
  body.push(0);
  // End children of compile_unit
  body.push(0);

  const unitLength = 2 + 4 + 1 + body.length;
  const debug_info = new Uint8Array([
    ...u32le(unitLength),
    ...u16le(4), // DWARF v4
    ...u32le(0), // abbrev offset
    8,           // address size = 8
    ...body,
  ]);

  return { debug_info, debug_abbrev };
}

function makeArm64Model(words, { baseAddr = 0x1000n, name = 'func0', symbolFor = null } = {}) {
  const insns = words.map((w, row) => ({
    row,
    address: baseAddr + BigInt(row * 4),
    size: 4,
    length: 4,
    word: w >>> 0,
    arch: 'arm64',
  }));
  return {
    arch: 'arm64',
    name,
    instructions: insns,
    symbolFor,
  };
}

// ---------------------------------------------------------------------------
// Bug #5: DWARF product connection + SymbolIndex.functionPrototypeAt + ret-only identity
// ---------------------------------------------------------------------------
test('Bug #5: analysisFromBinaryImage extracts DWARF funcPrototypes and SymbolIndex.functionPrototypeAt resolves them', () => {
  const dwarfSections = buildMinimalDwarf4({
    fnAddr: 0x401000n,
    fnName: 'identity_int',
    retTypeName: 'int',
    paramName: 'val',
    paramTypeName: 'int',
  });

  const fakeImage = {
    format: 'elf',
    arch: 'arm64',
    endian: 'little',
    symbols: [{ defined: true, address: 0x401000n, name: 'identity_int', exported: true }],
    exports: [],
    imports: [],
    functions: [{ address: 0x401000n, exactFunctionStart: true, source: 'symtab', confidence: 1 }],
    sections: [],
  };

  const result = analysisFromBinaryImage(fakeImage, { dwarfSections });
  assert.ok(result.funcPrototypes, 'funcPrototypes should be present on analysis result');
  const proto = result.funcPrototypes[String(0x401000n)];
  assert.ok(proto, 'prototype for 0x401000 should be extracted');
  assert.equal(proto.returnType, 'int');
  assert.deepEqual(proto.params, [{ name: 'val', type: 'int' }]);
  assert.equal(proto.signature, 'int identity_int(int val)');

  const symbols = new SymbolIndex(result);
  assert.deepEqual(symbols.functionPrototypeAt(0x401000n), proto);
  assert.deepEqual(symbols.functionPrototypeAt('0x401000'), proto);
  assert.deepEqual(symbols.functionPrototypeAt(Number(0x401000n)), proto);
  assert.equal(symbols.functionPrototypeAt(0x402000n), null);
});

test('Bug #5: Mach-O __DWARF in-memory sections are parsed by analysisFromBinaryImage', () => {
  const { debug_info, debug_abbrev } = buildMinimalDwarf4({
    fnAddr: 0x100004000n,
    fnName: 'pass_through',
    retTypeName: 'long',
    paramName: 'ptr',
    paramTypeName: 'long',
  });
  const fakeMacho = {
    format: 'macho',
    arch: 'arm64',
    endian: 'little',
    symbols: [],
    exports: [],
    imports: [],
    functions: [{ address: 0x100004000n, exactFunctionStart: true, source: 'function-starts', confidence: 1 }],
    sections: [
      { segment: '__DWARF', name: '__debug_info', bytes: debug_info },
      { segment: '__DWARF', name: '__debug_abbrev', bytes: debug_abbrev },
    ],
  };
  const result = analysisFromBinaryImage(fakeMacho);
  const symbols = new SymbolIndex(result);
  const proto = symbols.functionPrototypeAt(0x100004000n);
  assert.ok(proto);
  assert.equal(proto.returnType, 'long');
  assert.equal(proto.params[0].name, 'ptr');
});

test('Bug #5: ret-only identity function restores DWARF signature + return <arg0> via WASM, while stripped ret stays void(void)', () => {
  const retOnlyWords = [0xD65F03C0]; // ret
  const model = makeArm64Model(retOnlyWords, { baseAddr: 0x1000n, name: 'identity_fn' });

  // With DWARF prototype: WASM is NOT skipped, signature & return <arg0> restored
  const withProto = decompile(model, {
    addr: 0x1000n,
    name: 'identity_fn',
    functionPrototype: {
      name: 'identity_fn',
      returnType: 'int',
      params: [{ name: 'x', type: 'int' }],
      signature: 'int identity_fn(int x)',
    },
  });
  assert.equal(withProto.wasmAccelerated, true, 'should run via WASM even with functionPrototype');
  assert.match(withProto.pseudocode, /int identity_fn\(int x\)/);
  assert.match(withProto.pseudocode, /return x;/);

  // Stripped (no DWARF prototype): stays void identity_fn(void) { return; }
  const stripped = decompile(model, {
    addr: 0x1000n,
    name: 'identity_fn',
  });
  assert.equal(stripped.wasmAccelerated, true);
  assert.match(stripped.pseudocode, /void identity_fn\(void\)/);
  assert.match(stripped.pseudocode, /return;/);
});

// ---------------------------------------------------------------------------
// Bug #7: ObjC 3 C++ patterns + general ObjC allowGeneralObjcWasm + OBJC_IVAR resolution
// ---------------------------------------------------------------------------
test('Bug #7: ObjC ConstReturn, IvarGetter, IvarSetter emit typedef void * SEL; (id self, SEL _cmd, ...), no uninitialized self/a2/var_, and resolve OBJC_IVAR', () => {
  // Pattern 1: ConstReturn (8 words)
  // sub sp, sp, #0x10; str x0, [sp, #8]; str x1, [sp]; mov w0, #1; add sp, sp, #0x10; ret
  const constRetWords = [
    0xD10043FF, // sub sp, sp, #0x10
    0xF90007E0, // str x0, [sp, #8]
    0xF90003E1, // str x1, [sp]
    0x52800020, // mov w0, #1
    0x910043FF, // add sp, sp, #0x10
    0xD65F03C0, // ret
  ];
  // Check exact pattern expected by arm64_objc_emit (8 words with mov w0, #1; b next etc. or use direct 8-word sequence):
  // Let's test via the exact 8-word ConstReturn pattern if matched, or verify with allowGeneralObjcWasm:
  const resConst = wasmDecompileArm64Function({
    words: [
      0xD10043FF, // sub sp, sp, #16
      0xF90007E0, // str x0, [sp, #8]
      0xF90003E1, // str x1, [sp]
      0x52800028, // mov w8, #1
      0x2A0803E0, // mov w0, w8
      0x910043FF, // add sp, sp, #16
      0xD65F03C0, // ret
    ],
    baseAddr: 0x100004000n,
    funcName: '-[MyView isEnabled]',
    allowGeneralObjcWasm: true,
  });
  assert.ok(resConst, 'ObjC ConstReturn / general should succeed with allowGeneralObjcWasm');
  assert.ok(resConst.pseudocode.includes('typedef void * id;'), 'must declare typedef void * id;');
  assert.ok(resConst.pseudocode.includes('typedef void * SEL;'), 'must declare typedef void * SEL;');
  assert.ok(resConst.pseudocode.includes('-[MyView isEnabled](id self, SEL _cmd'), 'must use (id self, SEL _cmd)');
  assert.ok(!resConst.pseudocode.includes('uint64 self;'), 'must not declare uninitialized uint64 self;');
  assert.ok(!resConst.pseudocode.includes('uint64 a2;'), 'must not declare uninitialized uint64 a2;');

  // Pattern 2: Exact IvarGetter (12 words matching arm64_objc_emit.cpp)
  // 0: sub sp, sp, #0x10
  // 1: str x0, [sp, #8]
  // 2: str x1, [sp]
  // 3: ldr x8, [sp, #8]
  // 4: adrp x9, #0x100005000 (from 0x100004010 -> page delta +1: 0xB0000009)
  // 5: ldrsw x9, [x9, #0x10] (0xB9801129)
  // 6: add x8, x8, x9 (0x8B090108)
  // 7: ldr w0, [x8] (0xB9400100)
  // 8: add sp, sp, #0x10
  // 9: ret
  const ivarAddr = 0x100005010n;
  const symbolFor = (addr) => (BigInt(addr) === ivarAddr ? '_OBJC_IVAR_$_Player._score' : null);
  const resGetter = wasmDecompileArm64Function({
    words: [
      0xD10043FF, // sub sp, sp, #16
      0xF90007E0, // str x0, [sp, #8]
      0xF90003E1, // str x1, [sp]
      0xF94007E8, // ldr x8, [sp, #8]
      0xB0000009, // adrp x9, +1 page (0x100005000)
      0xB9801129, // ldrsw x9, [x9, #0x10]
      0x8B090108, // add x8, x8, x9
      0xB9400100, // ldr w0, [x8]
      0x910043FF, // add sp, sp, #16
      0xD65F03C0, // ret
    ],
    baseAddr: 0x100004000n,
    funcName: '-[Player score]',
    symbolFor,
    allowGeneralObjcWasm: true,
  });
  assert.ok(resGetter, 'ObjC IvarGetter should decompile');
  assert.ok(resGetter.pseudocode.includes('typedef void * SEL;'));
  assert.ok(resGetter.pseudocode.includes('-[Player score](id self, SEL _cmd'));
  assert.ok(!resGetter.pseudocode.includes('uint64 self;'));
  assert.ok(!resGetter.pseudocode.includes('uint64 a2;'));
  assert.ok(!/var_[0-9a-f]+/i.test(resGetter.pseudocode), 'must not contain uninitialized var_<self_off>');
  assert.ok(resGetter.pseudocode.includes('OBJC_IVAR_$_Player._score'), `expected OBJC_IVAR resolution, got:\n${resGetter.pseudocode}`);

  // Default (without allowGeneralObjcWasm) on non-fast-pattern ObjC method still falls back (differential parity)
  const defaultGeneral = wasmDecompileArm64Function({
    words: [0x0b010000, 0xd65f03c0],
    baseAddr: 0x1000n,
    funcName: '-[MyClass doThing:]',
  });
  assert.equal(defaultGeneral, null, 'default ObjC general method must still fall back for parity');
});

// ---------------------------------------------------------------------------
// Decompiler Readability: Magic constant division recovery
// ---------------------------------------------------------------------------
test('Decompiler readability: 32-bit signed / 10, / 7 (overflow-corrected), unsigned / 10, and 64-bit signed / 10 simplify cleanly', () => {
  // 1. 32-bit signed x0 / 10:
  // movz w9, #0x6667; movk w9, #0x6666, lsl #16; smull x8, w0, w9; asr x8, x8, #34; add w0, w8, w8, lsr #31; ret
  const sdiv10Words = [
    0x528CCCE9, // movz w9, #0x6667
    0x72ACCCCA, // wait: rd=w9 -> 0x72ACCCC9
    0x9B297C08, // smull x8, w0, w9
    0x9362FD08, // asr x8, x8, #34
    0x0B487D00, // add w0, w8, w8, lsr #31
    0xD65F03C0, // ret
  ];
  sdiv10Words[1] = 0x72ACCCC9; // movk w9, #0x6666, lsl #16
  // Pad to >= 8 words (or add nop/frame) so arm64_general_emit runs
  const sdiv10Framed = [
    0xA9BF7BFD, // stp x29, x30, [sp, #-16]!
    0x910003FD, // mov x29, sp
    ...sdiv10Words.slice(0, 5),
    0xA8C17BFD, // ldp x29, x30, [sp], #16
    0xD65F03C0, // ret
  ];
  const resS10 = wasmDecompileArm64Function({
    words: sdiv10Framed,
    baseAddr: 0x2000n,
    funcName: 'div_s32_10',
  });
  assert.ok(resS10, 'sdiv10 should decompile via WASM');
  assert.match(resS10.pseudocode, /\(int32_t\)x0 \/ 10/, `expected / 10, got:\n${resS10.pseudocode}`);

  // 2. 32-bit unsigned x0 / 10:
  // movz w9, #0xCCCD; movk w9, #0xCCCC, lsl #16; umull x8, w0, w9; lsr x0, x8, #35; ret
  const udiv10Framed = [
    0xA9BF7BFD, // stp x29, x30, [sp, #-16]!
    0x910003FD, // mov x29, sp
    0x529999A9, // movz w9, #0xCCCD
    0x72B99989, // movk w9, #0xCCCC, lsl #16
    0x9BA97C08, // umull x8, w0, w9
    0xD363FD00, // lsr x0, x8, #35
    0xA8C17BFD, // ldp x29, x30, [sp], #16
    0xD65F03C0, // ret
  ];
  const resU10 = wasmDecompileArm64Function({
    words: udiv10Framed,
    baseAddr: 0x2100n,
    funcName: 'div_u32_10',
  });
  assert.ok(resU10, 'udiv10 should decompile via WASM');
  assert.match(resU10.pseudocode, /\(uint32_t\)x0 \/ 10U/, `expected / 10U, got:\n${resU10.pseudocode}`);

  // 3. 32-bit signed x0 / 7 (overflow-corrected magic 0x92492493):
  // movz w9, #0x2493; movk w9, #0x9249, lsl #16; smull x8, w0, w9; asr x8, x8, #32; add w8, w8, w0; asr w8, w8, #2; add w0, w8, w8, lsr #31
  const sdiv7Framed = [
    0xA9BF7BFD, // stp x29, x30, [sp, #-16]!
    0x910003FD, // mov x29, sp
    0x52849269, // movz w9, #0x2493
    0x72B24929, // movk w9, #0x9249, lsl #16
    0x9B297C08, // smull x8, w0, w9
    0x9360FD08, // asr x8, x8, #32
    0x0B000108, // add w8, w8, w0
    0x13027D08, // asr w8, w8, #2
    0x0B487D00, // add w0, w8, w8, lsr #31
    0xA8C17BFD, // ldp x29, x30, [sp], #16
    0xD65F03C0, // ret
  ];
  const resS7 = wasmDecompileArm64Function({
    words: sdiv7Framed,
    baseAddr: 0x2200n,
    funcName: 'div_s32_7',
  });
  assert.ok(resS7, 'sdiv7 should decompile via WASM');
  assert.match(resS7.pseudocode, /\(int32_t\)x0 \/ 7/, `expected / 7, got:\n${resS7.pseudocode}`);

  // 4. Negative check: non-magic constant 0x66666666 must NOT simplify to / 10
  const badMagicFramed = [
    0xA9BF7BFD,
    0x910003FD,
    0x528CCCC9, // movz w9, #0x6666 (off by 1!)
    0x72ACCCC9, // movk w9, #0x6666, lsl #16
    0x9B297C08, // smull x8, w0, w9
    0x9362FD08, // asr x8, x8, #34
    0x0B487D00, // add w0, w8, w8, lsr #31
    0xA8C17BFD,
    0xD65F03C0,
  ];
  const resBad = wasmDecompileArm64Function({
    words: badMagicFramed,
    baseAddr: 0x2300n,
    funcName: 'not_div_10',
  });
  assert.ok(resBad);
  assert.doesNotMatch(resBad.pseudocode, /\/ 10\b/, 'off-by-1 magic constant must NOT simplify to / 10');
});

test('Bug #7: Exact C++ arm64_objc_emit.cpp 3 patterns (ConstReturn, IvarGetter, IvarSetter) emit clean (id self, SEL _cmd, ...) with typedef void * SEL;', () => {
  // 1. IvarGetter (exact 12-word arm64_32-objc pattern)
  const getterWords = [
    0xD10043FF, 0xAA0003E8, 0xB9000FE8, 0xAA0103E8,
    0xB9000BE8, 0xB9400FE8, 0x90000009, 0xB9800129,
    0x8B090108, 0xB9400100, 0x910043FF, 0xD65F03C0,
  ];
  const gRes = wasmDecompileArm64Function({
    words: getterWords,
    baseAddr: 0x20n,
    funcName: '-[Foo count]',
    allowGeneralObjcWasm: true,
    symbolFor: (a) => (BigInt(a) === 0n ? '_OBJC_IVAR_$_Foo._count' : null),
  });
  assert.ok(gRes, 'C++ IvarGetter should succeed');
  assert.ok(gRes.pseudocode.includes('typedef void * SEL;'));
  assert.ok(gRes.pseudocode.includes('int32 -[Foo count](id self, SEL _cmd)'));
  assert.ok(!gRes.pseudocode.includes('uint64 self;'));
  assert.ok(!gRes.pseudocode.includes('uint64 a2;'));
  assert.ok(!/var_[0-9A-Fa-f]+/.test(gRes.pseudocode));
  assert.ok(gRes.pseudocode.includes('OBJC_IVAR_$_Foo._count'));

  // 2. IvarSetter (exact 14-word arm64_32-objc pattern)
  const setterWords = [
    0xD10043FF, 0xAA0003E8, 0xB9000FE8, 0xAA0103E8,
    0xB9000BE8, 0xB90007E2, 0xB94007E8, 0xB9400FE9,
    0x9000000A, 0xB980014A, 0x8B0A0129, 0xB9000128,
    0x910043FF, 0xD65F03C0,
  ];
  const sRes = wasmDecompileArm64Function({
    words: setterWords,
    baseAddr: 0x50n,
    funcName: '-[Foo setCount:]',
    allowGeneralObjcWasm: true,
    symbolFor: (a) => (BigInt(a) === 0n ? '_OBJC_IVAR_$_Foo._count' : null),
  });
  assert.ok(sRes, 'C++ IvarSetter should succeed');
  assert.ok(sRes.pseudocode.includes('typedef void * SEL;'));
  assert.ok(sRes.pseudocode.includes('id -[Foo setCount:](id self, SEL _cmd, uint64 a3)'));
  assert.ok(!sRes.pseudocode.includes('uint64 self;'));
  assert.ok(!sRes.pseudocode.includes('uint64 a2;'));
  assert.ok(sRes.pseudocode.includes('OBJC_IVAR_$_Foo._count'));
});

// ---------------------------------------------------------------------------
// Gate 2 R1 Regressions: Bug #5 body param substitution & typedefs, Magic div LSR>32 & live intermediate reg
// ---------------------------------------------------------------------------
test('Bug #5 regression: applyFunctionPrototypeToC rewrites body param names (a1/a2 -> lhs/rhs) and adds missing stdint typedefs', () => {
  // add w0, w0, w1; add w0, w0, #1; ret
  const addOneWords = [0x0B010000, 0x11000400, 0xD65F03C0];
  const model = makeArm64Model(addOneWords, { baseAddr: 0x1000n, name: 'add_one' });
  const res = decompile(model, {
    addr: 0x1000n,
    name: 'add_one',
    functionPrototype: {
      name: 'add_one',
      returnType: 'int',
      params: [
        { name: 'lhs', type: 'int' },
        { name: 'rhs', type: 'int' },
      ],
      signature: 'int add_one(int lhs, int rhs)',
    },
  });
  assert.equal(res.wasmAccelerated, true);
  assert.match(res.pseudocode, /int add_one\(int lhs, int rhs\)/);
  assert.match(res.pseudocode, /\(lhs \+ rhs\) \+ 1/);
  assert.doesNotMatch(res.pseudocode, /\ba1\b/, `a1 must not remain in body:\n${res.pseudocode}`);
  assert.doesNotMatch(res.pseudocode, /\ba2\b/, `a2 must not remain in body:\n${res.pseudocode}`);

  // Standard-width typedef completion when DWARF prototype uses int32_t / uint64_t
  const resStdint = decompile(model, {
    addr: 0x1000n,
    name: 'add_one_std',
    functionPrototype: {
      name: 'add_one_std',
      returnType: 'int32_t',
      params: [
        { name: 'lhs', type: 'int32_t' },
        { name: 'rhs', type: 'uint64_t' },
      ],
      signature: 'int32_t add_one_std(int32_t lhs, uint64_t rhs)',
    },
  });
  assert.ok(resStdint.pseudocode.includes('typedef __INT32_TYPE__ int32_t;'), `missing int32_t typedef:\n${resStdint.pseudocode}`);
  assert.ok(resStdint.pseudocode.includes('typedef __UINT64_TYPE__ uint64_t;'), `missing uint64_t typedef:\n${resStdint.pseudocode}`);
  assert.match(resStdint.pseudocode, /\(lhs \+ rhs\) \+ 1/);
});

test('Magic div regression: 32-bit signed SMULL + LSR #34 (sh > 32) must NOT fold to / 10', () => {
  // movz w9, #0x6667; movk w9, #0x6666, lsl #16; smull x8, w0, w9; lsr x8, x8, #34; add w0, w8, w8, lsr #31; ret
  const lsr34Framed = [
    0xA9BF7BFD, // stp x29, x30, [sp, #-16]!
    0x910003FD, // mov x29, sp
    0x528CCCE9, // movz w9, #0x6667
    0x72ACCCC9, // movk w9, #0x6666, lsl #16
    0x9B297C08, // smull x8, w0, w9
    0xD362FD08, // lsr x8, x8, #34  (logical shift > 32 breaks signed semantics!)
    0x0B487D00, // add w0, w8, w8, lsr #31
    0xA8C17BFD, // ldp x29, x30, [sp], #16
    0xD65F03C0, // ret
  ];
  const res = wasmDecompileArm64Function({
    words: lsr34Framed,
    baseAddr: 0x2400n,
    funcName: 'sdiv10_bad_lsr34',
  });
  assert.ok(res, 'should decompile via WASM');
  assert.doesNotMatch(res.pseudocode, /\/ 10\b/, `LSR #34 must NOT simplify to / 10:\n${res.pseudocode}`);
});

test('Magic div regression: live intermediate register x9 used after rounding must abort folding and preserve x9', () => {
  // movz w8, #0x5556; movk w8, #0x5555, lsl #16 (magic for signed / 3, shift 32)
  // smull x9, w0, w8; asr x10, x9, #32; add w0, w10, w10, lsr #31; add x0, x0, x9; ret
  const liveX9Framed = [
    0xA9BF7BFD, // stp x29, x30, [sp, #-16]!
    0x910003FD, // mov x29, sp
    0x528AAAC8, // movz w8, #0x5556
    0x72AAAAA8, // movk w8, #0x5555, lsl #16
    0x9B287C09, // smull x9, w0, w8
    0x9360FD2A, // asr x10, x9, #32
    0x0B4A7D40, // add w0, w10, w10, lsr #31
    0x8B090000, // add x0, x0, x9  <-- x9 is live!
    0xA8C17BFD, // ldp x29, x30, [sp], #16
    0xD65F03C0, // ret
  ];
  const resLive = wasmDecompileArm64Function({
    words: liveX9Framed,
    baseAddr: 0x2500n,
    funcName: 'sdiv3_live_x9',
  });
  assert.ok(resLive, 'should decompile via WASM');
  assert.doesNotMatch(resLive.pseudocode, /\/ 3\b/, `must abort folding when intermediate x9 is live:\n${resLive.pseudocode}`);
  assert.match(resLive.pseudocode, /\bx9\b/, `intermediate x9 must be preserved in output:\n${resLive.pseudocode}`);

  // Control: without `add x0, x0, x9`, x9 is dead at ret and DOES fold to / 3
  const deadX9Framed = [
    0xA9BF7BFD,
    0x910003FD,
    0x528AAAC8,
    0x72AAAAA8,
    0x9B287C09,
    0x9360FD2A,
    0x0B4A7D40,
    0xA8C17BFD,
    0xD65F03C0,
  ];
  const resDead = wasmDecompileArm64Function({
    words: deadX9Framed,
    baseAddr: 0x2600n,
    funcName: 'sdiv3_dead_x9',
  });
  assert.ok(resDead, 'control sdiv3 should decompile via WASM');
  assert.match(resDead.pseudocode, /\(int32_t\)x0 \/ 3\b/, `expected / 3 when x9 is dead:\n${resDead.pseudocode}`);
});

test('Bug #5 R2 regression: non-void DWARF return type with unknown target falls back to uint64 and unsafe C++ names/types sanitize cleanly', () => {
  // 1. DWARF subprogram with DW_AT_type pointing to an unresolved/unknown type DIE (e.g. DW_TAG_unspecified_type or broken ref)
  // Test via wasmDecompileArm64Function with proto containing C++ qualified name and non-C DWARF types
  const retOnly = new Uint32Array([0xd65f03c0]); // ret
  const res = wasmDecompileArm64Function({
    words: retOnly,
    baseAddr: 0x3000n,
    funcName: 'sub_3000',
    functionPrototype: {
      name: 'Foo::bar',
      returnType: 'unknown *',
      params: [
        { name: 'self', type: 'class Widget *' },
        { name: 'arr', type: 'int[]' },
        { name: 'anon', type: 'struct <anonymous>' },
      ],
    },
  });
  assert.ok(res && res.pseudocode, 'WASM decompile should succeed');
  assert.match(res.pseudocode, /void \* sub_3000\(void \* self, uint64 arr, uint64 anon\)/, `unexpected sanitized signature:\n${res.pseudocode}`);
  assert.doesNotMatch(res.pseudocode, /Foo::bar|int\[\]|<anonymous>|class Widget/, 'unsafe C++ / non-C tokens must not leak');
  assert.match(res.pseudocode, /return self;/, 'non-void ret-only identity should still emit return self;');
});

test('Magic div R2 regression: Pattern D/E with sd == cur_reg (lsr w8, w8, #31; add w0, w8, w8) must NOT fold to signed division', () => {
  // sub sp, sp, #16; movz w9, #0x5556; movk w9, #0x5555, lsl #16; smull x8, w0, w9; lsr x8, x8, #32;
  // lsr w8, w8, #31 (clobbers cur_reg w8!); add w0, w8, w8; add sp, sp, #16; ret
  const badPatternD = new Uint32Array([
    0xd10043ff, // sub sp, sp, #16
    0x528aaac9, // movz w9, #0x5556
    0x72aaaaa9, // movk w9, #0x5555, lsl #16
    0x9b297c08, // smull x8, w0, w9
    0xd360fd08, // lsr x8, x8, #32
    0x531f7d08, // lsr w8, w8, #31  (sd=8 == cur_reg=8!)
    0x0b080100, // add w0, w8, w8
    0x910043ff, // add sp, sp, #16
    0xd65f03c0, // ret
  ]);
  const res = wasmDecompileArm64Function({
    words: badPatternD,
    baseAddr: 0x3100n,
    funcName: 'bad_pattern_d',
  });
  assert.ok(res && res.pseudocode, 'WASM decompile should succeed');
  assert.doesNotMatch(res.pseudocode, /\/ 3\b/, `sd == cur_reg must NOT fold to / 3:\n${res.pseudocode}`);

  // Positive control: distinct sd (w10) in Pattern D MUST fold to / 3
  const goodPatternD = new Uint32Array([
    0xd10043ff, // sub sp, sp, #16
    0x528aaac9, // movz w9, #0x5556
    0x72aaaaa9, // movk w9, #0x5555, lsl #16
    0x9b297c08, // smull x8, w0, w9
    0xd360fd08, // lsr x8, x8, #32
    0x531f7d0a, // lsr w10, w8, #31 (sd=10 != cur_reg=8)
    0x0b0a0100, // add w0, w8, w10
    0x910043ff, // add sp, sp, #16
    0xd65f03c0, // ret
  ]);
  const resGood = wasmDecompileArm64Function({
    words: goodPatternD,
    baseAddr: 0x3140n,
    funcName: 'good_pattern_d',
  });
  assert.ok(resGood && resGood.pseudocode, 'control Pattern D should succeed');
  assert.match(resGood.pseudocode, /\(int32_t\)x0 \/ 3\b/, `control Pattern D must fold to / 3:\n${resGood.pseudocode}`);
});

test('Magic div R3 regression: clobbering div_reg (prod_reg == div_reg) must NOT fold overflow-add to / 7', () => {
  // sub sp, sp, #16; movz w9, #0x2493; movk w9, #0x9249, lsl #16 (0x92492493 for signed / 7);
  // smull x0, w0, w9 (clobbers x0 == div_reg!); asr x8, x0, #32;
  // add w8, w8, w0 (adds low 32 bits of product, NOT original w0!);
  // asr w8, w8, #2; add w0, w8, w8, lsr #31; add sp, sp, #16; ret
  const clobberDivReg = new Uint32Array([
    0xd10043ff, // sub sp, sp, #16
    0x52849269, // movz w9, #0x2493
    0x72b24929, // movk w9, #0x9249, lsl #16
    0x9b297c00, // smull x0, w0, w9  (prod_reg=0 == div_reg=0!)
    0x9360fc08, // asr x8, x0, #32
    0x0b000108, // add w8, w8, w0
    0x13027d08, // asr w8, w8, #2
    0x0b487d00, // add w0, w8, w8, lsr #31
    0x910043ff, // add sp, sp, #16
    0xd65f03c0, // ret
  ]);
  const res = wasmDecompileArm64Function({
    words: clobberDivReg,
    baseAddr: 0x3200n,
    funcName: 'clobber_div_reg',
  });
  assert.ok(res && res.pseudocode, 'WASM decompile should succeed');
  assert.doesNotMatch(res.pseudocode, /\/ 7\b/, `clobbered div_reg must NOT fold to / 7:\n${res.pseudocode}`);

  // Positive control: non-clobbering prod_reg (x8 != x0) MUST fold to / 7
  const goodDiv7 = new Uint32Array([
    0xd10043ff, // sub sp, sp, #16
    0x52849269, // movz w9, #0x2493
    0x72b24929, // movk w9, #0x9249, lsl #16
    0x9b297c08, // smull x8, w0, w9  (prod_reg=8 != div_reg=0)
    0x9360fd08, // asr x8, x8, #32
    0x0b000108, // add w8, w8, w0
    0x13027d08, // asr w8, w8, #2
    0x0b487d00, // add w0, w8, w8, lsr #31
    0x910043ff, // add sp, sp, #16
    0xd65f03c0, // ret
  ]);
  const resGood = wasmDecompileArm64Function({
    words: goodDiv7,
    baseAddr: 0x3240n,
    funcName: 'good_div_7',
  });
  assert.ok(resGood && resGood.pseudocode, 'control sdiv7 should succeed');
  assert.match(resGood.pseudocode, /\(int32_t\)x0 \/ 7\b/, `control sdiv7 must fold to / 7:\n${resGood.pseudocode}`);
});

test('Bug #5 R3 regression: partial DWARF prototype with fewer params preserves body-referenced trailing params', () => {
  // add w0, w0, w1; add w0, w0, #1; ret
  const addTwo = new Uint32Array([
    0x0b010000, // add w0, w0, w1
    0x11000400, // add w0, w0, #1
    0xd65f03c0, // ret
  ]);
  const res = wasmDecompileArm64Function({
    words: addTwo,
    baseAddr: 0x3300n,
    funcName: 'sub_3300',
    functionPrototype: {
      name: 'add_two',
      returnType: 'int',
      params: [],
    },
  });
  assert.ok(res && res.pseudocode, 'WASM decompile should succeed');
  assert.match(res.pseudocode, /int add_two\([^)]*\ba1\b[^)]*\ba2\b[^)]*\)/, `expected a1 and a2 preserved in signature:\n${res.pseudocode}`);
  assert.doesNotMatch(res.pseudocode, /int add_two\(void\)/, 'must not drop referenced parameters into (void)');
});

test('Bug #5 R3 regression: DWARF subprogram with DW_AT_type pointing to unknown DIE falls back to uint64 (not void)', () => {
  // Minimal DWARF v4 .debug_abbrev + .debug_info with DW_TAG_subprogram whose DW_AT_type references DW_TAG_unspecified_type
  const abbrev = new Uint8Array([
    1, 0x11, 1, 0, 0,                             // abbrev 1: DW_TAG_compile_unit, has_children=1
    2, 0x2e, 0,                                   // abbrev 2: DW_TAG_subprogram, has_children=0
      0x03, 0x08,                                 //   DW_AT_name (DW_FORM_string)
      0x11, 0x01,                                 //   DW_AT_low_pc (DW_FORM_addr)
      0x49, 0x13,                                 //   DW_AT_type (DW_FORM_ref4)
      0, 0,
    3, 0x3b, 0, 0, 0,                             // abbrev 3: DW_TAG_unspecified_type, has_children=0
    0,
  ]);
  const infoBytes = [];
  const pushU32 = (v) => infoBytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const pushU64 = (v) => { pushU32(Number(v & 0xffffffffn)); pushU32(Number((v >> 32n) & 0xffffffffn)); };
  const pushStr = (s) => { for (const ch of s) infoBytes.push(ch.charCodeAt(0)); infoBytes.push(0); };
  // CU header: unit_length(4), version(2)=4, abbrev_offset(4)=0, addr_size(1)=8 -> 11 bytes
  pushU32(0); // placeholder for unit_length
  infoBytes.push(4, 0); // version = 4
  pushU32(0); // abbrev_offset = 0
  infoBytes.push(8); // addr_size = 8
  infoBytes.push(1); // abbrev 1: compile_unit (offset 11)
  // subprogram starts at offset 12: abbrev(1) + "mystery\0"(8) + low_pc(8) + ref4(4) = 21 bytes -> ends at 33
  const typeDieOffset = 33;
  infoBytes.push(2); // abbrev 2: subprogram
  pushStr('mystery');
  pushU64(0x4000n);
  pushU32(typeDieOffset);
  infoBytes.push(3); // abbrev 3: unspecified_type at offset 33
  infoBytes.push(0); // end children of compile_unit
  const unitLen = infoBytes.length - 4;
  infoBytes[0] = unitLen & 0xff;
  infoBytes[1] = (unitLen >>> 8) & 0xff;
  infoBytes[2] = (unitLen >>> 16) & 0xff;
  infoBytes[3] = (unitLen >>> 24) & 0xff;

  const parsed = parseDebugInfo({
    debug_info: new Uint8Array(infoBytes),
    debug_abbrev: abbrev,
  }, undefined, { endian: 'little' });
  const protos = extractFunctionPrototypes(parsed);
  const proto = protos?.['16384'];
  assert.ok(proto, 'expected prototype at 0x4000 (16384)');
  assert.equal(proto.name, 'mystery');
  assert.equal(proto.returnType, 'uint64', `non-void DW_AT_type resolving to unknown must fall back to uint64, got ${proto.returnType}`);
});
