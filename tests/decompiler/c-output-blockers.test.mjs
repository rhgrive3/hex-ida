import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { closeFunctionOutput } from '../../js/decompiler/c-output-closure.js';
import { decompileSemantic } from '../../js/decompiler/semantic-core.js';
import { applyStructuredControlProjection } from '../../js/decompiler/phase8/structured-control-projection.js';
import { buildCTranslationUnit } from '../../js/analysis/query/translation-unit.js';
import { OP, VK } from '../../js/ir-core.js';

function findCC() {
  for (const cc of ['gcc', 'clang']) {
    try {
      execFileSync(cc, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
      return cc;
    } catch { /* try next */ }
  }
  return null;
}

const CC = findCC();

function assertStrictCSyntax(code, label = '') {
  if (!CC) return;
  try {
    execFileSync(CC, ['-x', 'c', '-fsyntax-only', '-Werror=int-conversion', '-'], {
      input: code,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = String(err.stderr || err.message || '');
    assert.fail(`${label ? `${label}: ` : ''}C syntax/-Werror=int-conversion failed:\n${code}\n--- stderr ---\n${stderr}`);
  }
}

function makeResult(lines) {
  return {
    lines,
    pseudocode: lines.map((l) => `${'    '.repeat(l.indent || 0)}${l.text}`).join('\n'),
  };
}

function assertIdempotent(result, label = '') {
  const onceCode = result.pseudocode;
  const onceCount = result.lines.length;
  closeFunctionOutput(result);
  assert.equal(result.pseudocode, onceCode, `${label}: not idempotent (pseudocode changed)`);
  assert.equal(result.lines.length, onceCount, `${label}: not idempotent (line count changed)`);
}

test('1. -Wint-conversion: pointer-returning libc calls, expanded libc pointer args, recursive self-calls, if-headers, and initialized body decls', () => {
  const res = makeResult([
    { kind: 'sig', indent: 0, text: 'char *find_and_copy(const char *s, uint64 raw_buf, uint64 depth)', row: 0, addr: 0x1000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'decl', indent: 1, text: 'int64 raw_dup = strdup(raw_buf);' },
    { kind: 'decl', indent: 1, text: 'void *ptr_init = raw_buf + 8;' },
    { kind: 'stmt', indent: 1, text: 'p_alloc = malloc(64);' },
    { kind: 'stmt', indent: 1, text: 'p_hit = strchr(raw_buf, 65);' },
    { kind: 'stmt', indent: 1, text: 'memcpy(raw_buf, s, 16);' },
    { kind: 'ctrl', indent: 1, text: 'if (strcmp(raw_buf, "needle") == 0) {' },
    { kind: 'stmt', indent: 2, text: 'rec_val = find_and_copy(raw_buf, ptr_init, depth - 1);' },
    { kind: 'stmt', indent: 2, text: 'free(p_alloc);' },
    { kind: 'ctrl', indent: 2, text: 'return rec_val;' },
    { kind: 'ctrl', indent: 1, text: '}' },
    { kind: 'stmt', indent: 1, text: 'int_slot = malloc(32);' },
    { kind: 'stmt', indent: 1, text: 'masked = int_slot & 0xFF;' },
    { kind: 'ctrl', indent: 1, text: 'return p_hit ? p_hit : raw_dup;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(res);

  // Initialized body decls coerced
  assert.match(res.pseudocode, /int64 raw_dup = \(uintptr_t\)\(strdup\(\(const char \*\)\(uintptr_t\)\(raw_buf\)\)\);/);
  assert.match(res.pseudocode, /void \*ptr_init = \(void \*\)\(uintptr_t\)\(raw_buf \+ 8\);/);
  // Pure pointer-returning libc local stays void * so `p_alloc = malloc(64);` stays uncast
  assert.match(res.pseudocode, /void \* p_alloc;/);
  assert.match(res.pseudocode, /p_alloc = malloc\(64\);/);
  // Bitwise-used malloc local stays uint64 and coerces RHS
  assert.match(res.pseudocode, /uint64 int_slot;/);
  assert.match(res.pseudocode, /int_slot = \(uintptr_t\)\(malloc\(32\)\);/);
  // Expanded libc pointer args in statements and !part.hasSemi `if (...) {` headers
  assert.match(res.pseudocode, /memcpy\(\(void \*\)\(uintptr_t\)\(raw_buf\), s, 16\);/);
  assert.match(res.pseudocode, /if \(strcmp\(\(const char \*\)\(uintptr_t\)\(raw_buf\), "needle"\) == 0\) \{/);
  // Recursive call respects own sigText parameter types (arg0 const char *, arg1 uint64) and return type (char *)
  assert.match(res.pseudocode, /find_and_copy\(\(const char \*\)\(uintptr_t\)\(raw_buf\), \(uintptr_t\)\(ptr_init\), depth - 1\)/);
  assert.match(res.pseudocode, /rec_val = \(uintptr_t\)\(find_and_copy\(/);
  assert.match(res.pseudocode, /return \(char \*\)\(uintptr_t\)\(rec_val\);/);

  assertStrictCSyntax(res.pseudocode, 'Wint-conversion full coverage');
  assertIdempotent(res, 'Wint-conversion full coverage');
});

test('2. invalid type argument of -> on uint64 / int64 / void * rewrites field_<HEX> and named fields without mutating sigText', () => {
  const sig = 'uint64 read_fields(uint64 a1, void * a2, int64 a3)';
  const res = makeResult([
    { kind: 'sig', indent: 0, text: sig, row: 0, addr: 0x2000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'decl', indent: 1, text: 'uint64 v1;' },
    { kind: 'stmt', indent: 1, text: 'v1 = a1;' },
    { kind: 'stmt', indent: 1, text: 'x = a1->field_0 + a2->field_8 + a3->field_10;' },
    { kind: 'stmt', indent: 1, text: 'v1->field_18 = x;' },
    { kind: 'stmt', indent: 1, text: 'y = a2->count + a1->tag;' },
    { kind: 'ctrl', indent: 1, text: 'return x + y;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(res);

  // sigText must NOT be mutated
  const sigLine = res.lines.find((l) => l.kind === 'sig');
  assert.equal(sigLine.text, sig, 'sigText must remain unchanged');

  // Exact byte offset rewrites for field_<HEX>
  assert.match(res.pseudocode, /\*\(uint64 \*\)\(\(uintptr_t\)\(a1\) \+ 0x0\)/);
  assert.match(res.pseudocode, /\*\(uint64 \*\)\(\(uintptr_t\)\(a2\) \+ 0x8\)/);
  assert.match(res.pseudocode, /\*\(uint64 \*\)\(\(uintptr_t\)\(a3\) \+ 0x10\)/);
  assert.match(res.pseudocode, /\*\(uint64 \*\)\(\(uintptr_t\)\(v1\) \+ 0x18\) = x;/);

  // Synthetic struct cast + typedef for non-offset named fields
  assert.match(res.pseudocode, /typedef struct (?:hex_struct_a2 )?\{[^}]*uint64 count;[^}]*\} hex_struct_a2;/);
  assert.match(res.pseudocode, /typedef struct (?:hex_struct_a1 )?\{[^}]*uint64 tag;[^}]*\} hex_struct_a1;/);
  assert.match(res.pseudocode, /\(\(hex_struct_a2 \*\)\(uintptr_t\)\(a2\)\)->count/);
  assert.match(res.pseudocode, /\(\(hex_struct_a1 \*\)\(uintptr_t\)\(a1\)\)->tag/);

  assertStrictCSyntax(res.pseudocode, 'arrow rewrite on uint64/int64/void *');
  assertIdempotent(res, 'arrow rewrite on uint64/int64/void *');
});

test('3a. semantic-core unaryText handles is-zero and is-nonzero cleanly', () => {
  const a1 = { id: 1, bits: 64, signed: false, kind: VK.ARG, reg: 'x0', def: null, uses: [] };
  const vZero = { id: 2, bits: 32, signed: false, kind: VK.REG, reg: 'w0', def: null, uses: [] };
  const vNonZero = { id: 3, bits: 32, signed: false, kind: VK.REG, reg: 'w1', def: null, uses: [] };
  const vSum = { id: 4, bits: 32, signed: false, kind: VK.REG, reg: 'w0', def: null, uses: [] };

  const iZero = { id: 1, row: 0, address: 0x3000n, block: 0, op: OP.UN, sub: 'is-zero', dst: vZero, args: [{ value: a1 }] };
  const iNonZero = { id: 2, row: 1, address: 0x3004n, block: 0, op: OP.UN, sub: 'is-nonzero', dst: vNonZero, args: [{ value: a1 }] };
  const iAdd = { id: 3, row: 2, address: 0x3008n, block: 0, op: OP.BIN, sub: 'add', dst: vSum, args: [{ value: vZero }, { value: vNonZero }] };
  const iRet = { id: 4, row: 3, address: 0x300cn, block: 0, op: OP.RET, args: [{ value: vSum }] };

  vZero.def = iZero;
  vNonZero.def = iNonZero;
  vSum.def = iAdd;
  a1.uses.push(iZero, iNonZero);
  vZero.uses.push(iAdd);
  vNonZero.uses.push(iAdd);
  vSum.uses.push(iRet);

  const ir = {
    entry: 0,
    blocks: [{ index: 0, startRow: 0, endRow: 3, succ: [], pred: [], phis: [], insts: [iZero, iNonZero, iAdd, iRet] }],
    values: [a1, vZero, vNonZero, vSum],
    instructions: [iZero, iNonZero, iAdd, iRet],
    args: new Map([['x0', a1]]),
    locations: new Map(),
    stackSlots: [],
    loops: [],
    byRow: new Map([[0, iZero], [1, iNonZero], [2, iAdd], [3, iRet]]),
  };
  const model = {
    arch: 'arm64',
    name: 'check_zero_ops',
    instructions: ir.instructions.map((i) => ({ row: i.row, address: i.address, mnemonic: 'nop', ops: [], reads: [], writes: [] })),
  };

  const sem = decompileSemantic(model, { ir });
  closeFunctionOutput(sem);

  assert.doesNotMatch(sem.pseudocode, /\bis_zero\s*\(/);
  assert.doesNotMatch(sem.pseudocode, /\bis_nonzero\s*\(/);
  assert.match(sem.pseudocode, /\(a1\) == 0/);
  assert.match(sem.pseudocode, /\(a1\) != 0/);
  assertStrictCSyntax(sem.pseudocode, 'unaryText is-zero / is-nonzero');
});

test('3b. c-output-closure emits guarded static inline bit_extract/bit_insert helpers and translation-unit hoists them cleanly', () => {
  const f1 = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 fn_bits_a(uint64 a1, uint64 a2)', row: 0, addr: 0x4000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'ctrl', indent: 1, text: 'return bit_insert(a1, bit_extract(a2, 4, 8), 8, 8);' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  const f2 = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 fn_bits_b(uint64 a1)', row: 0, addr: 0x4100n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'ctrl', indent: 1, text: 'return bit_extract(a1, 0, 16);' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(f1);
  closeFunctionOutput(f2);

  // Raw call spelling preserved + guarded static inline helpers defined
  assert.match(f1.pseudocode, /\bbit_extract\(a2, 4, 8\)/);
  assert.match(f1.pseudocode, /\bbit_insert\(a1,/);
  assert.match(f1.pseudocode, /#ifndef __hex_(?:helper_)?bit_extract_defined/);
  assert.match(f1.pseudocode, /static inline uint64(?:_t)? bit_extract\(/);
  assert.match(f1.pseudocode, /#ifndef __hex_(?:helper_)?bit_insert_defined/);
  assert.match(f1.pseudocode, /static inline uint64(?:_t)? bit_insert\(/);
  assert.doesNotMatch(f1.pseudocode, /uint64 bit_extract \(__HEX_ANY_ARGS\);/);

  assertStrictCSyntax(f1.pseudocode, 'single-function bit_extract/bit_insert');
  assertIdempotent(f1, 'single-function bit_extract/bit_insert');

  // Translation unit hoists guarded helpers once and keeps both functions faithful
  const unit = buildCTranslationUnit([
    { address: 0x4000n, name: 'fn_bits_a', pseudocode: f1.pseudocode },
    { address: 0x4100n, name: 'fn_bits_b', pseudocode: f2.pseudocode },
  ]);
  assert.equal(unit.functions[0].syntaxOnly, false, 'fn_bits_a should be emitted faithfully');
  assert.equal(unit.functions[1].syntaxOnly, false, 'fn_bits_b should be emitted faithfully');
  assert.equal((unit.source.match(/static inline uint64(?:_t)? bit_extract\(/g) || []).length, 1, 'bit_extract helper should be hoisted exactly once');
  assert.equal((unit.source.match(/static inline uint64(?:_t)? bit_insert\(/g) || []).length, 1, 'bit_insert helper should be hoisted exactly once');
  assert.equal(unit.unresolved.length, 0, `expected zero unresolved entries, got: ${JSON.stringify(unit.unresolved)}`);
  assertStrictCSyntax(unit.source, 'translation unit with hoisted bitfield helpers');
});

test('4. structured-control-projection fails closed on multi-line block branches (if (cond) { ... }) and never unbalances braces', () => {
  const cbr = { id: 1, row: 0, address: 0x5000n, block: 0, op: 'cbr', cond: 'eq', args: [], extra: { targetBlock: 1 } };
  const br1 = { id: 2, row: 1, address: 0x5004n, block: 1, op: 'br', args: [] };
  const ret = { id: 3, row: 2, address: 0x5008n, block: 2, op: 'ret', args: [] };

  const blocks = [
    { index: 0, startRow: 0, endRow: 0, address: 0x5000n, succ: [1, 2], pred: [], insts: [cbr], successorEdges: [{ to: 1, kind: 'conditional-true' }, { to: 2, kind: 'conditional-false' }] },
    { index: 1, startRow: 1, endRow: 1, address: 0x5004n, succ: [2], pred: [0], insts: [br1] },
    { index: 2, startRow: 2, endRow: 2, address: 0x5008n, succ: [], pred: [0, 1], insts: [ret] },
  ];
  const ir = {
    entry: 0,
    blocks,
    instructions: [cbr, br1, ret],
    idom: [0, 0, 0],
    ipdom: [2, 2, null],
  };

  // Multi-line faithfulCfg PHI-copy block: `if (a1 == 0) { phi_1 = 1; goto loc_5004; }`
  const body = [
    { kind: 'sig', indent: 0, text: 'uint64 phi_block_fn(uint64 a1)', row: 0, addr: 0x5000n },
    { kind: 'ctrl', indent: 0, text: '{', row: 0, addr: 0x5000n },
    { kind: 'ctrl', indent: 1, text: 'if (a1 == 0) {', block: 0, row: 0, addr: 0x5000n },
    { kind: 'stmt', indent: 2, text: 'phi_1 = 1;', block: 0, row: 0, addr: 0x5000n },
    { kind: 'stmt', indent: 2, text: 'goto loc_5004;', block: 0, row: 0, addr: 0x5000n },
    { kind: 'ctrl', indent: 1, text: '}', block: 0, row: 0, addr: 0x5000n },
    { kind: 'stmt', indent: 1, text: 'phi_1 = 2;', block: 0, row: 0, addr: 0x5000n },
    { kind: 'stmt', indent: 1, text: 'goto loc_5008;', block: 0, row: 0, addr: 0x5000n },
    { kind: 'label', indent: 0, text: 'loc_5004:', block: 1, row: 1, addr: 0x5004n },
    { kind: 'stmt', indent: 1, text: 'phi_1 = phi_1 + 10;', block: 1, row: 1, addr: 0x5004n },
    { kind: 'stmt', indent: 1, text: 'goto loc_5008;', block: 1, row: 1, addr: 0x5004n },
    { kind: 'label', indent: 0, text: 'loc_5008:', block: 2, row: 2, addr: 0x5008n },
    { kind: 'ctrl', indent: 1, text: 'return phi_1;', block: 2, row: 2, addr: 0x5008n },
    { kind: 'ctrl', indent: 0, text: '}', row: 2, addr: 0x5008n },
  ];

  const result = {
    ir,
    cAst: { kind: 'program', body },
    lines: body,
    pseudocode: body.map((n) => `${'    '.repeat(n.indent)}${n.text}`).join('\n'),
  };

  const facts = {
    completeness: 'complete',
    regions: [{ kind: 'conditional', entry: 0, exits: [2], members: [1], constraints: [], residualGotos: [] }],
    edges: [
      { from: 0, to: 1, construct: 'conditional-true' },
      { from: 0, to: 2, construct: 'conditional-false' },
      { from: 1, to: 2, construct: 'conditional-join' },
    ],
  };
  const dominators = {
    idom: [0, 0, 0],
    ipdom: [2, 2, null],
    dominators: [new Set([0]), new Set([0, 1]), new Set([0, 2])],
    postDominators: [new Set([0, 2]), new Set([1, 2]), new Set([2])],
  };
  const analysis = new Map([
    ['structuredRegions', facts],
    ['cfg', { blocks }],
    ['dominators', dominators],
  ]);

  const projected = applyStructuredControlProjection(result, analysis, {});
  // Must fail closed and preserve original result (balanced braces, loc_5004/loc_5008 still inside function)
  assert.equal(projected, result, 'must fail closed on multi-line if (cond) { block branch');
  const closed = closeFunctionOutput({ lines: projected.lines.map((l) => ({ ...l })), pseudocode: projected.pseudocode });
  assertStrictCSyntax(closed.pseudocode, 'multi-line PHI-copy block preserved with balanced braces');
});

test('5. Finding 1: recursive self-calls with function-pointer and array params decay arrays and skip fn-ptr casts', () => {
  const res = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 walk_cb(int (*cb)(int, int), char buf[16], uint64 raw_n)', row: 0, addr: 0x6000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'decl', indent: 1, text: 'void *p_arg = buf;' },
    { kind: 'stmt', indent: 1, text: 'uint64 next_buf = raw_n + 16;' },
    { kind: 'ctrl', indent: 1, text: 'if (raw_n > 0) return walk_cb(cb, next_buf, p_arg);' },
    { kind: 'ctrl', indent: 1, text: 'return raw_n;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(res);

  // Array param decays to char *, fn-ptr param is NOT spliced into a broken cast, arg2 pointer coerces to uintptr_t
  assert.match(res.pseudocode, /walk_cb\(cb, \(char \*\)\(uintptr_t\)\(next_buf\), \(uintptr_t\)\(p_arg\)\)/);
  assert.doesNotMatch(res.pseudocode, /\(int \(\*\)/);
  assertStrictCSyntax(res.pseudocode, 'Finding 1: recursive self-call with fn-ptr and array param');
  assertIdempotent(res, 'Finding 1: recursive self-call with fn-ptr and array param');
});

test('6. Finding 2: inferMutablePtrReturnLocals avoids void * on +/+= arithmetic, compound RHS, and commented assignments', () => {
  const res = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 alloc_arith(uint64 x, uint64 cond)', row: 0, addr: 0x6100n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'p_plus = malloc(64);' },
    { kind: 'stmt', indent: 1, text: 'p_plus += 8;' },
    { kind: 'stmt', indent: 1, text: 'p_expr = malloc(64) + (x);' },
    { kind: 'stmt', indent: 1, text: 'p_tern = cond ? malloc(64) : (x);' },
    { kind: 'stmt', indent: 1, text: 'p_tern2 = malloc(64) ? x : (x + 1);' },
    { kind: 'stmt', indent: 1, text: '// p_cmt = malloc(64);' },
    { kind: 'stmt', indent: 1, text: 'p_cmt = x + 4;' },
    { kind: 'ctrl', indent: 1, text: 'return p_plus + p_expr + p_tern + p_tern2 + p_cmt;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(res);

  assert.match(res.pseudocode, /uint64 p_plus;/);
  assert.match(res.pseudocode, /uint64 p_expr;/);
  assert.match(res.pseudocode, /uint64 p_tern;/);
  assert.match(res.pseudocode, /uint64 p_tern2;/);
  assert.match(res.pseudocode, /uint64 p_cmt;/);
  assert.doesNotMatch(res.pseudocode, /void \* p_plus;/);
  assert.doesNotMatch(res.pseudocode, /void \* p_expr;/);
  assert.doesNotMatch(res.pseudocode, /void \* p_tern2;/);
  assertStrictCSyntax(res.pseudocode, 'Finding 2: inferMutablePtrReturnLocals no void * arithmetic');
  assertIdempotent(res, 'Finding 2: inferMutablePtrReturnLocals no void * arithmetic');
});

test('7. Finding 3 & 6: chained non-struct arrow accesses and pre-existing hex_struct_<ident> typedef collision', () => {
  const res = makeResult([
    { kind: 'decl', indent: 0, text: 'typedef __UINT64_TYPE__ uint64;' },
    { kind: 'decl', indent: 0, text: 'typedef struct { uint64 old_field; } hex_struct_a1;' },
    { kind: 'sig', indent: 0, text: 'uint64 chained_arrows(uint64 a1, void *a2)', row: 0, addr: 0x6200n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'v_off = a1->field_8->field_10;' },
    { kind: 'stmt', indent: 1, text: 'v_named = a1->foo->bar;' },
    { kind: 'stmt', indent: 1, text: 'v_mix = a2->field_8->baz;' },
    { kind: 'ctrl', indent: 1, text: 'return v_off + v_named + v_mix;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(res);

  // Chained field_<HEX>->field_<HEX>
  assert.match(res.pseudocode, /\(\*\(uint64 \*\)\(\(uintptr_t\)\(\*\(uint64 \*\)\(\(uintptr_t\)\(a1\) \+ 0x8\)\) \+ 0x10\)\)/);
  // Pre-existing hex_struct_a1 lacks foo, so non-colliding struct typedef is allocated
  assert.match(res.pseudocode, /typedef struct \{ uint64 foo; \} hex_struct_a1_arrow;/);
  assert.match(res.pseudocode, /typedef struct \{ uint64 bar; \} hex_struct_a1_foo;/);
  assert.match(res.pseudocode, /typedef struct \{ uint64 baz; \} hex_struct_a2_field_8;/);
  assertStrictCSyntax(res.pseudocode, 'Finding 3 & 6: chained arrows and struct collision');
  assertIdempotent(res, 'Finding 3 & 6: chained arrows and struct collision');
});

test('8. Finding 4: translation-unit strips bitfield helper #endif without stripping unrelated #ifndef __hex_atomic_load_defined #endif', () => {
  const f1 = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 atomic_and_bits(uint64 *p, uint64 a2)', row: 0, addr: 0x6300n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'v = __atomic_load(p);' },
    { kind: 'ctrl', indent: 1, text: 'return bit_extract(v ^ a2, 4, 8);' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(f1);
  assert.match(f1.pseudocode, /#ifndef __hex_atomic_load_defined/);
  assert.match(f1.pseudocode, /#ifndef __hex_(?:helper_)?bit_extract_defined/);
  assertStrictCSyntax(f1.pseudocode, 'Finding 4: single function with atomic + bit_extract');

  const unit = buildCTranslationUnit([
    { address: 0x6300n, name: 'atomic_and_bits', pseudocode: f1.pseudocode },
  ]);
  // Atomic #ifndef/#endif pair must remain balanced in the packaged translation unit
  const ifndefCount = (unit.source.match(/^#ifndef\b/gm) || []).length;
  const ifCount = (unit.source.match(/^#if\b/gm) || []).length;
  const endifCount = (unit.source.match(/^#endif\b/gm) || []).length;
  assert.equal(endifCount, ifndefCount + ifCount, 'preprocessor #ifndef/#if and #endif directives must stay balanced');
  assertStrictCSyntax(unit.source, 'Finding 4: translation unit with atomic + bit_extract');
});

test('9. Finding 5: bit_extract and bit_insert coerce pointer arguments with (uintptr_t)', () => {
  const res = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 ptr_bits(void *a1, const char *a2)', row: 0, addr: 0x6400n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'lo = bit_extract(a1, 0, 12);' },
    { kind: 'ctrl', indent: 1, text: 'return bit_insert(a1, a2, 12, 16) | lo;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(res);

  assert.match(res.pseudocode, /bit_extract\(\(uintptr_t\)\(a1\), 0, 12\)/);
  assert.match(res.pseudocode, /bit_insert\(\(uintptr_t\)\(a1\), \(uintptr_t\)\(a2\), 12, 16\)/);
  assertStrictCSyntax(res.pseudocode, 'Finding 5: bit_extract/bit_insert with pointer args');
  assertIdempotent(res, 'Finding 5: bit_extract/bit_insert with pointer args');
});

test('10. Finding 11: structured-control-projection handles trailing comments on block branches and embedded newlines in // comments', () => {
  const cbr = { id: 1, row: 0, address: 0x7000n, block: 0, op: 'cbr', cond: 'eq', args: [], extra: { targetBlock: 1 } };
  const br1 = { id: 2, row: 1, address: 0x7004n, block: 1, op: 'br', args: [] };
  const ret = { id: 3, row: 2, address: 0x7008n, block: 2, op: 'ret', args: [] };

  const blocks = [
    { index: 0, startRow: 0, endRow: 0, address: 0x7000n, succ: [1, 2], pred: [], insts: [cbr], successorEdges: [{ to: 1, kind: 'conditional-true' }, { to: 2, kind: 'conditional-false' }] },
    { index: 1, startRow: 1, endRow: 1, address: 0x7004n, succ: [2], pred: [0], insts: [br1] },
    { index: 2, startRow: 2, endRow: 2, address: 0x7008n, succ: [], pred: [0, 1], insts: [ret] },
  ];
  const ir = {
    entry: 0,
    blocks,
    instructions: [cbr, br1, ret],
    idom: [0, 0, 0],
    ipdom: [2, 2, null],
  };

  for (const branchHeader of ['if (a1 == 0) { // phi copy', 'if (a1 == 0) { /* phi copy */']) {
    const body = [
      { kind: 'sig', indent: 0, text: 'uint64 phi_comment_fn(uint64 a1)', row: 0, addr: 0x7000n },
      { kind: 'ctrl', indent: 0, text: '{', row: 0, addr: 0x7000n },
      { kind: 'ctrl', indent: 1, text: branchHeader, block: 0, row: 0, addr: 0x7000n },
      { kind: 'stmt', indent: 2, text: '// embedded comment\nphi_1 = 1;', block: 0, row: 0, addr: 0x7000n },
      { kind: 'stmt', indent: 2, text: 'goto loc_7004;', block: 0, row: 0, addr: 0x7000n },
      { kind: 'ctrl', indent: 1, text: '}', block: 0, row: 0, addr: 0x7000n },
      { kind: 'stmt', indent: 1, text: 'phi_1 = 2;', block: 0, row: 0, addr: 0x7000n },
      { kind: 'stmt', indent: 1, text: 'goto loc_7008;', block: 0, row: 0, addr: 0x7000n },
      { kind: 'label', indent: 0, text: 'loc_7004:', block: 1, row: 1, addr: 0x7004n },
      { kind: 'stmt', indent: 1, text: 'phi_1 = phi_1 + 10;', block: 1, row: 1, addr: 0x7004n },
      { kind: 'stmt', indent: 1, text: 'goto loc_7008;', block: 1, row: 1, addr: 0x7004n },
      { kind: 'label', indent: 0, text: 'loc_7008:', block: 2, row: 2, addr: 0x7008n },
      { kind: 'ctrl', indent: 1, text: 'return phi_1;', block: 2, row: 2, addr: 0x7008n },
      { kind: 'ctrl', indent: 0, text: '}', row: 2, addr: 0x7008n },
    ];
    const result = {
      ir,
      cAst: { kind: 'program', body },
      lines: body,
      pseudocode: body.map((n) => `${'    '.repeat(n.indent)}${n.text}`).join('\n'),
    };
    const facts = {
      completeness: 'complete',
      regions: [{ kind: 'conditional', entry: 0, exits: [2], members: [1], constraints: [], residualGotos: [] }],
      edges: [
        { from: 0, to: 1, construct: 'conditional-true' },
        { from: 0, to: 2, construct: 'conditional-false' },
        { from: 1, to: 2, construct: 'conditional-join' },
      ],
    };
    const dominators = {
      idom: [0, 0, 0],
      ipdom: [2, 2, null],
      dominators: [new Set([0]), new Set([0, 1]), new Set([0, 2])],
      postDominators: [new Set([0, 2]), new Set([1, 2]), new Set([2])],
    };
    const analysis = new Map([
      ['structuredRegions', facts],
      ['cfg', { blocks }],
      ['dominators', dominators],
    ]);
    const projected = applyStructuredControlProjection(result, analysis, {});
    assert.equal(projected, result, `must fail closed on commented block branch: ${branchHeader}`);
  }
});
