import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  callArgumentIndices,
  knownCallPrototype,
  knownCallSignature,
} from '../../js/decompiler/call-prototypes.js';
import {
  inferSemanticTypes,
  semanticSignature,
} from '../../js/decompiler/type-recovery.js';
import {
  closeFunctionOutput,
  scanIdentifierUses,
} from '../../js/decompiler/c-output-closure.js';
import { OP } from '../../js/ir.js';

function findGcc() {
  for (const cc of ['gcc', 'clang']) {
    try {
      execFileSync(cc, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
      return cc;
    } catch { /* try next */ }
  }
  return null;
}

const CC = findGcc();

function assertStrictCSyntax(code, label = '') {
  if (!CC) return;
  try {
    execFileSync(CC, ['-x', 'c', '-fsyntax-only', '-Werror=int-conversion', '-w', '-'], {
      input: code,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = String(err.stderr || err.message || '');
    assert.fail(`${label ? `${label}: ` : ''}GCC -Werror=int-conversion failed:\n${code}\n--- stderr ---\n${stderr}`);
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

test('1. call-prototypes: C stdlib & math arities, decorations, and typed signatures', () => {
  const fixedExpect = [
    ['fabs', 1], ['_fabs', 1], ['fabsf', 1], ['sqrt', 1], ['j__sqrt', 1],
    ['floor', 1], ['ceil', 1], ['sin', 1], ['cos', 1], ['tan', 1], ['round', 1],
    ['pow', 2], ['pow@@GLIBC_2.17', 2], ['fmod', 2], ['atan2', 2], ['fma', 3],
    ['strlen', 1], ['strcmp', 2], ['strncmp', 3], ['strcpy', 2], ['strncpy', 3],
    ['memcpy', 3], ['memmove', 3], ['memset', 3], ['malloc', 1], ['calloc', 2],
    ['realloc', 2], ['free', 1], ['qsort', 4], ['bsearch', 5],
    ['atoi', 1], ['strtol', 3], ['strtod', 2], ['fgets', 3], ['abort', 0], ['rand', 0],
  ];
  for (const [sym, arity] of fixedExpect) {
    const proto = knownCallPrototype(sym);
    assert.ok(proto, `expected prototype for ${sym}`);
    assert.equal(proto.arity, arity, `${sym} arity`);
    assert.equal(proto.variadic, false, `${sym} variadic`);
    assert.deepEqual(callArgumentIndices({ name: sym }), Array.from({ length: arity }, (_, i) => i));
  }

  for (const [sym, minArity] of [['printf', 1], ['fprintf', 2], ['sprintf', 2], ['snprintf', 3], ['sscanf', 2], ['__isoc99_sscanf', 2]]) {
    const proto = knownCallPrototype(sym);
    assert.ok(proto, `expected variadic prototype for ${sym}`);
    assert.equal(proto.arity, minArity, `${sym} min arity`);
    assert.equal(proto.variadic, true, `${sym} variadic`);
  }

  // Typed signature metadata for float/double/pointer recovery.
  assert.deepEqual(knownCallSignature('fabs')?.paramTypes, ['double']);
  assert.equal(knownCallSignature('fabs')?.retType, 'double');
  assert.deepEqual(knownCallSignature('powf')?.paramTypes, ['float', 'float']);
  assert.equal(knownCallSignature('powf')?.retType, 'float');
  assert.deepEqual(knownCallSignature('qsort')?.paramTypes, ['ptr', 'size', 'size', 'ptr']);
  assert.equal(knownCallSignature('malloc')?.retType, 'ptr');
  assert.deepEqual(knownCallSignature('strtol')?.paramTypes, ['ptr', 'ptr', 'int']);
});

test('2. type-recovery: -O2 FP vs integer args, call-site propagation, and dead-arg suppression', () => {
  // 2a. Mixed integer (x0) + double (d0) function with dead x1 PHI, dead x2 MOV, and stale model.argRegs=[0,1,2,3].
  const x0 = { id: 1, reg: 'x0', bits: 32, uses: [] };
  const x1 = { id: 2, reg: 'x1', bits: 64, uses: [] };
  const x2 = { id: 3, reg: 'x2', bits: 64, uses: [] };
  const x3 = { id: 4, reg: 'x3', bits: 64, uses: [] };
  const d0 = { id: 5, reg: 'd0', bits: 64, uses: [] };
  const deadPhiDst = { id: 6, reg: 'x1', bits: 64, uses: [] };
  const deadMovDst = { id: 7, reg: 'x2', bits: 64, uses: [] };
  const fmulDst = { id: 8, reg: 'd0', bits: 64, uses: [] };
  const sxtDst = { id: 9, reg: 'x0', bits: 64, uses: [] };
  const i2fDst = { id: 10, reg: 'd1', bits: 64, uses: [] };

  const deadPhi = { id: 'i_phi', row: 1, block: 0, op: OP.PHI, dst: deadPhiDst, args: [{ value: x1 }, { value: deadPhiDst }] };
  deadPhiDst.def = deadPhi;
  deadPhiDst.uses.push(deadPhi); // self-loop only -> dead!
  x1.uses.push(deadPhi);

  const deadMov = { id: 'i_mov', row: 2, block: 0, op: OP.MOV, dst: deadMovDst, args: [{ value: x2 }] };
  deadMovDst.def = deadMov;
  x2.uses.push(deadMov);

  const sxt = { id: 'i_sxt', row: 3, block: 0, op: OP.UN, sub: 'sxt32', dst: sxtDst, args: [{ value: x0 }] };
  sxtDst.def = sxt;
  x0.uses.push(sxt);

  const i2f = { id: 'i_i2f', row: 4, block: 0, op: OP.UN, sub: 'i2f', dst: i2fDst, args: [{ value: sxtDst }] };
  i2fDst.def = i2f;
  sxtDst.uses.push(i2f);

  const fmul = { id: 'i_fmul', row: 5, block: 0, op: OP.BIN, sub: 'fmul', dst: fmulDst, args: [{ value: d0 }, { value: i2fDst }] };
  fmulDst.def = fmul;
  d0.uses.push(fmul);
  i2fDst.uses.push(fmul);

  const ret = { id: 'i_ret', row: 6, block: 0, op: OP.RET, args: [] };

  const ir = {
    blocks: [{ id: 0, idom: -1 }],
    idom: [-1],
    values: [x0, x1, x2, x3, d0, deadPhiDst, deadMovDst, fmulDst, sxtDst, i2fDst],
    args: new Map([['x0', x0], ['x1', x1], ['x2', x2], ['x3', x3], ['d0', d0]]),
    instructions: [deadPhi, deadMov, sxt, i2f, fmul, ret],
  };

  const recovered = inferSemanticTypes(ir, { argRegs: [0, 1, 2, 3] });
  assert.equal(recovered.args.length, 2, `expected exactly 2 live args (x0, d0), got ${JSON.stringify(recovered.args.map((a) => a.reg))}`);
  assert.equal(recovered.args[0].reg, 'x0');
  assert.equal(recovered.args[0].type, 'int32');
  assert.equal(recovered.args[1].reg, 'd0');
  assert.equal(recovered.args[1].type, 'double');
  assert.equal(recovered.ret.type, 'double');
  assert.equal(semanticSignature('scale_value', recovered), 'double scale_value(int32 a1, double a2)');

  // 2b. Call-site prototype propagation: strlen(x0) proves x0 is pointer, and live-through x1 past arity 1 is not an arg.
  const px0 = { id: 20, reg: 'x0', bits: 64, uses: [] };
  const px1 = { id: 21, reg: 'x1', bits: 64, uses: [] };
  const lenDst = { id: 22, reg: 'x0', bits: 64, uses: [] };
  const callStrlen = {
    id: 'c_strlen', row: 1, block: 0, op: OP.CALL, dst: lenDst,
    extra: { name: '_strlen' },
    args: [{ value: px0 }, { value: px1 }],
  };
  lenDst.def = callStrlen;
  px0.uses.push(callStrlen);
  px1.uses.push(callStrlen);
  const retLen = { id: 'c_ret', row: 2, block: 0, op: OP.RET, args: [{ value: lenDst }] };
  lenDst.uses.push(retLen);

  const ir2 = {
    blocks: [{ id: 0, idom: -1 }],
    idom: [-1],
    values: [px0, px1, lenDst],
    args: new Map([['x0', px0], ['x1', px1]]),
    instructions: [callStrlen, retLen],
  };
  const rec2 = inferSemanticTypes(ir2, {});
  assert.equal(rec2.args.length, 1, 'live-through x1 beyond strlen arity 1 must not become an argument');
  assert.equal(rec2.args[0].type, 'void *');
  assert.equal(rec2.ret.type, 'uint64');
});

test('3. c-output-closure: mixed ternaries in parens, call args, casts, returns, ctrl, and nested ternaries', () => {
  const res = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 mixed_ternaries(void * a1, uint64 a2, uint64 cond, uint64 c2)', row: 0, addr: 0x1000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'x8 = (cond ? "hello" : a2);' },
    { kind: 'stmt', indent: 1, text: 'x9 = (uint64)(cond ? a1 : 1) + 4;' },
    { kind: 'stmt', indent: 1, text: 'x10 = helper(cond ? "yes" : a2, (c2 ? a1 : 2));' },
    { kind: 'stmt', indent: 1, text: 'x11 = cond ? (c2 ? "nested" : a2) : a1;' },
    { kind: 'ctrl', indent: 1, text: 'if ((cond ? a1 : 1) != 0) {' },
    { kind: 'ctrl', indent: 2, text: 'return (cond ? a1 : 1) + x8 + x9 + x10 + x11;' },
    { kind: 'ctrl', indent: 1, text: '}' },
    { kind: 'ctrl', indent: 1, text: 'return 0;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(res);
  assert.match(res.pseudocode, /x8 = \(cond \? \(uintptr_t\)\("hello"\) : a2\);/);
  assert.match(res.pseudocode, /x9 = \(uint64\)\(cond \? \(uintptr_t\)\(a1\) : 1\) \+ 4;/);
  assert.match(res.pseudocode, /helper\(cond \? \(uintptr_t\)\("yes"\) : a2, \(c2 \? \(uintptr_t\)\(a1\) : 2\)\)/);
  assert.match(res.pseudocode, /if \(\(cond \? \(uintptr_t\)\(a1\) : 1\) != 0\)/);
  assertStrictCSyntax(res.pseudocode, 'nested mixed ternaries');
  assertIdempotent(res, 'nested mixed ternaries');
});

test('4. c-output-closure: vector128 <- char * and uint64 <- uint64 * assignments across all statement forms', () => {
  const res = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 ptr_assign_forms(void * a1, uint64 cond)', row: 0, addr: 0x2000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'decl', indent: 1, text: 'vector128 v0;' },
    { kind: 'decl', indent: 1, text: 'vector128 v1 = "init_str";' },
    { kind: 'decl', indent: 1, text: 'uint64 var_20;' },
    { kind: 'decl', indent: 1, text: 'uint64 p_init = &var_20;' },
    { kind: 'stmt', indent: 1, text: 'v0 = "direct_str";' },
    { kind: 'stmt', indent: 1, text: '*(vector128 *)(a1) = "deref_str";' },
    { kind: 'stmt', indent: 1, text: 'if (cond) v0 = "if_str";' },
    { kind: 'stmt', indent: 1, text: 'x1 = 0;   v2 = "paired_str";' },
    { kind: 'stmt', indent: 1, text: '*(uint64 *)(a1) = &var_20;' },
    { kind: 'stmt', indent: 1, text: 'if (cond) x20 = &var_20;' },
    { kind: 'stmt', indent: 1, text: 'else x20 = (uint64 *)a1;' },
    { kind: 'stmt', indent: 1, text: 'x21 |= &var_20;' },
    { kind: 'stmt', indent: 1, text: 'obj->field_0 = &var_20;' },
    { kind: 'ctrl', indent: 1, text: 'return (uint64)v0 + (uint64)v1 + (uint64)v2 + p_init + x1 + x20 + x21 + obj->field_0;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(res);
  assert.match(res.pseudocode, /v0 = \(uintptr_t\)\("direct_str"\);/);
  assert.match(res.pseudocode, /\*\(vector128 \*\)\(a1\) = \(uintptr_t\)\("deref_str"\);/);
  assert.match(res.pseudocode, /if \(cond\) v0 = \(uintptr_t\)\("if_str"\);/);
  assert.match(res.pseudocode, /\*\(uint64 \*\)\(a1\) = \(uintptr_t\)\(&var_20\);/);
  assert.match(res.pseudocode, /if \(cond\) x20 = \(uintptr_t\)\(&var_20\);/);
  assert.match(res.pseudocode, /x21 \|= \(uintptr_t\)\(&var_20\);/);
  assert.match(res.pseudocode, /obj->field_0 = \(uintptr_t\)\(&var_20\);/);
  assertStrictCSyntax(res.pseudocode, 'vector128 and uint64 pointer assignments');
  assertIdempotent(res, 'vector128 and uint64 pointer assignments');
});

test('5. c-output-closure: floating-point casts and vars in bitwise ops (&, |, ^, ~, <<, >>)', () => {
  const res = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 fp_bitwise(double d0, float s0)', row: 0, addr: 0x3000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'v3 = (double)v0 + v1 & ~v1 | v2;' },
    { kind: 'stmt', indent: 1, text: 'x0 = (double)v0 & 0x7fffffffffffffffULL;' },
    { kind: 'stmt', indent: 1, text: 'x1 = d0 ^ 0x8000000000000000ULL;' },
    { kind: 'stmt', indent: 1, text: 'x2 = ~d0;' },
    { kind: 'stmt', indent: 1, text: 'x3 = ((float)s0 + 1.0f) << 2;' },
    { kind: 'stmt', indent: 1, text: 'x4 &= (double)v0;' },
    { kind: 'ctrl', indent: 1, text: 'return (uint64)v3 + x0 + x1 + x2 + x3 + x4;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(res);
  assert.match(res.pseudocode, /v3 = \(uint64\)\(\(double\)v0 \+ v1\) & ~v1 \| v2;/);
  assert.match(res.pseudocode, /x1 = \(uint64\)\(d0\) \^ 0x8000000000000000ULL;/);
  assert.match(res.pseudocode, /x2 = ~\(uint64\)\(d0\);/);
  assertStrictCSyntax(res.pseudocode, 'floating-point bitwise protection');
  assertIdempotent(res, 'floating-point bitwise protection');
});

test('6. c-output-closure: x20 undeclared regressions (decl initializer RHS, nested block decl, register cast guard)', () => {
  // 6a. Register name `x20` inside parens before an ident is never misclassified as castType.
  const uses = scanIdentifierUses('(x20) + 1; [recv sel:(x20) next:y];');
  assert.equal(uses.get('x20')?.castType, false, 'x20 must never be classified as castType');
  assert.equal(uses.get('x20')?.value, true, 'x20 must remain a value use');

  // 6b. decl initializer referencing x20 + nested block `uint64 x20;` must not suppress function-level `uint64 x20;`.
  const res = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 x20_decl_closure(uint64 a1)', row: 0, addr: 0x4000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'decl', indent: 1, text: 'uint64 var_8 = x20;' },
    { kind: 'ctrl', indent: 1, text: 'if (a1) {' },
    { kind: 'stmt', indent: 2, text: 'uint64 x20 = a1;' },
    { kind: 'stmt', indent: 2, text: 'var_8 = x20 + 1;' },
    { kind: 'ctrl', indent: 1, text: '}' },
    { kind: 'stmt', indent: 1, text: 'x20 = var_8 + a1;' },
    { kind: 'ctrl', indent: 1, text: 'return x20;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(res);
  assert.match(res.pseudocode, /\n    uint64 x20;\n/, 'top-level uint64 x20; must be emitted');
  assertStrictCSyntax(res.pseudocode, 'x20 undeclared regression');
  assertIdempotent(res, 'x20 undeclared regression');
});
