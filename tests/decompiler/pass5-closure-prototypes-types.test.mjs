import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  knownCallPrototype,
  knownCallSignature,
} from '../../js/decompiler/call-prototypes.js';
import {
  closeFunctionOutput,
  isStandaloneGlobalPreludeDeclaration,
  STANDARD_C_LIBRARY_HEADERS,
} from '../../js/decompiler/c-output-closure.js';
import { buildCTranslationUnit } from '../../js/analysis/query/translation-unit.js';
import { inferSemanticTypes } from '../../js/decompiler/type-recovery.js';
import { OP } from '../../js/ir.js';

const AARCH64_GCC = (() => {
  for (const cc of ['aarch64-linux-gnu-gcc', 'gcc', 'clang']) {
    try {
      execFileSync(cc, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
      return cc;
    } catch { /* try next */ }
  }
  return null;
})();

function compileObjectO0(code, label = '') {
  assert.ok(AARCH64_GCC, 'expected aarch64-linux-gnu-gcc (or gcc/clang) to be installed');
  try {
    execFileSync(AARCH64_GCC, ['-O0', '-x', 'c', '-c', '-', '-o', '/dev/null'], {
      input: code,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = String(err.stderr || err.message || '');
    assert.fail(`${label}: ${AARCH64_GCC} -O0 -c failed:\n${code}\n--- stderr ---\n${stderr}`);
  }
}

function makeResult(lines) {
  return {
    lines,
    pseudocode: lines.map((l) => `${'    '.repeat(l.indent || 0)}${l.text}`).join('\n'),
  };
}

test('call-prototypes: void/noreturn libc prototypes and stpcpy_chk arity + signatures', () => {
  const fixedCases = [
    ['__stack_chk_fail', 'stack_chk_fail', 0],
    ['stack_chk_fail', 'stack_chk_fail', 0],
    ['__chk_fail', 'chk_fail', 0],
    ['__assert_fail', 'assert_fail', 4],
    ['clearerr', 'clearerr', 1],
    ['_exit', 'exit', 1],
    ['quick_exit', 'quick_exit', 1],
    ['longjmp', 'longjmp', 2],
    ['__stpcpy_chk', 'stpcpy_chk', 3],
    ['stpcpy_chk', 'stpcpy_chk', 3],
  ];
  for (const [input, expectedName, expectedArity] of fixedCases) {
    const proto = knownCallPrototype(input);
    assert.ok(proto, `expected prototype for ${input}`);
    assert.equal(proto.name, expectedName);
    assert.equal(proto.arity, expectedArity);
    assert.equal(proto.variadic, false);
  }

  const voidSigCases = [
    ['__stack_chk_fail', []],
    ['__chk_fail', []],
    ['__assert_fail', ['ptr', 'ptr', 'int', 'ptr']],
    ['exit', ['int']],
    ['_exit', ['int']],
    ['quick_exit', ['int']],
    ['abort', []],
    ['bzero', ['ptr', 'size']],
    ['bcopy', ['ptr', 'ptr', 'size']],
    ['rewind', ['ptr']],
    ['perror', ['ptr']],
    ['srand', ['int']],
    ['clearerr', ['ptr']],
    ['longjmp', ['ptr', 'int']],
  ];
  for (const [name, expectedParams] of voidSigCases) {
    const sig = knownCallSignature(name);
    assert.ok(sig, `expected signature for ${name}`);
    assert.equal(sig.retType, 'void', `${name} must have retType void`);
    assert.deepEqual(sig.paramTypes, expectedParams, `${name} paramTypes mismatch`);
  }

  const stpcpyChkSig = knownCallSignature('__stpcpy_chk');
  assert.ok(stpcpyChkSig);
  assert.equal(stpcpyChkSig.arity, 3);
  assert.equal(stpcpyChkSig.retType, 'ptr');
  assert.deepEqual(stpcpyChkSig.paramTypes, ['ptr', 'ptr', 'size']);
});

test('c-output-closure: stpcpy_chk / __stpcpy_chk header, alias, pointer return, and GCC -O0 compile', () => {
  assert.equal(STANDARD_C_LIBRARY_HEADERS.get('__stpcpy_chk'), '<string.h>');

  const result = makeResult([
    { kind: 'sig', indent: 0, text: 'char * copy_str(char * dst, const char * src, size_t dstlen)', row: 0, addr: 0x1000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'end = stpcpy_chk(dst, src, dstlen);' },
    { kind: 'ctrl', indent: 1, text: 'return end;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(result);

  assert.match(result.pseudocode, /#include <string\.h>/);
  assert.match(result.pseudocode, /extern char \*__stpcpy_chk\(char \*, const char \*, size_t\);/);
  assert.match(result.pseudocode, /#define stpcpy_chk __stpcpy_chk/);
  assert.doesNotMatch(result.pseudocode, /uint64\s+stpcpy_chk\s*\(__HEX_ANY_ARGS\)/);
  assert.match(result.pseudocode, /end = \(uintptr_t\)\(stpcpy_chk\(dst, src, dstlen\)\);/);

  // Idempotent on second pass.
  const once = result.pseudocode;
  closeFunctionOutput(result);
  assert.equal(result.pseudocode, once);

  compileObjectO0(result.pseudocode, 'stpcpy_chk closure compile');
});

test('c-output-closure: dereferenced standalone global gets static backing word; non-dereferenced stays = 0', () => {
  assert.equal(isStandaloneGlobalPreludeDeclaration('static uint64 __hex_global_1FFD0_backing = 0;'), true);
  assert.equal(
    isStandaloneGlobalPreludeDeclaration('static uint64 global_1FFD0 = (uint64)(uintptr_t)&__hex_global_1FFD0_backing;'),
    true,
  );
  assert.equal(
    isStandaloneGlobalPreludeDeclaration('static uint64 global_1FFD0 = (uint64)(uintptr_t)&__hex_global_OTHER_backing;'),
    false,
  );

  // Dereferenced GOT-style stack canary global_1FFD0 + non-dereferenced global_20000 (including binary multiply).
  const result = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 check_canary(uint64 a)', row: 0, addr: 0x2000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'uint64 canary = *(uint64_t *)(uintptr_t)(global_1FFD0);' },
    { kind: 'stmt', indent: 1, text: 'uint64 prod = a * global_20000;' },
    { kind: 'ctrl', indent: 1, text: 'return canary + prod;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(result);

  assert.match(result.pseudocode, /static uint64 __hex_global_1FFD0_backing = 0;/);
  assert.match(result.pseudocode, /static uint64 global_1FFD0 = \(uint64\)\(uintptr_t\)&__hex_global_1FFD0_backing;/);
  assert.match(result.pseudocode, /static uint64 global_20000 = 0;/);
  assert.doesNotMatch(result.pseudocode, /__hex_global_20000_backing/);

  // Idempotent on second pass.
  const once = result.pseudocode;
  closeFunctionOutput(result);
  assert.equal(result.pseudocode, once);

  // TU packager strips both the backing word and the pointer-initialized global.
  const unit = buildCTranslationUnit([
    { address: 0x2000n, name: 'check_canary', signature: 'uint64 check_canary(uint64 a)', pseudocode: result.pseudocode },
  ]);
  assert.doesNotMatch(unit.source, /__hex_global_1FFD0_backing/);
  assert.doesNotMatch(unit.source, /static uint64 global_1FFD0 =/);
  assert.doesNotMatch(unit.source, /static uint64 global_20000 = 0;/);

  compileObjectO0(result.pseudocode, 'dereferenced global_1FFD0 backing compile');
});

test('type-recovery: AArch64 FP/GP arg-set separation prevents duplicate v0 and spurious x2..x7 gap-filling', () => {
  const mkVal = (id, reg, bits = 64) => ({ id, reg, bits, uses: [], def: null });
  const vX0 = mkVal(1, 'x0', 64);
  const vX1 = mkVal(2, 'x1', 64);
  const vV0 = mkVal(3, 'v0', 64);
  const vSum = mkVal(4, 'x0', 64);
  const vFRes = mkVal(5, 'd0', 64);

  const addInst = { id: 10, row: 0, block: 0, op: OP.BIN, sub: 'add', args: [{ value: vX0 }, { value: vX1 }], dst: vSum };
  const faddInst = { id: 11, row: 1, block: 0, op: OP.BIN, sub: 'fadd', args: [{ value: vV0 }, { value: vV0 }], dst: vFRes };
  const retInst = { id: 12, row: 2, block: 0, op: OP.RET, args: [{ value: vFRes }] };
  vSum.def = addInst;
  vFRes.def = faddInst;
  vX0.uses.push(addInst);
  vX1.uses.push(addInst);
  vV0.uses.push(faddInst);
  vFRes.uses.push(retInst);

  const ir = {
    blocks: [{ id: 0, succs: [], preds: [] }],
    instructions: [addInst, faddInst, retInst],
    values: [vX0, vX1, vV0, vSum, vFRes],
    args: new Map([['x0', vX0], ['x1', vX1], ['v0', vV0]]),
    stackSlots: [],
    locations: new Map(),
  };

  const aarch64Adapter = {
    supported: true,
    argumentRegisters: () => [
      'x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7',
      'v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7',
    ],
    returnRegister: ({ returnType } = {}) => (returnType === 'double' ? 'd0' : 'x0'),
  };

  const recovered = inferSemanticTypes(ir, {}, { abiAdapter: aarch64Adapter });
  const argRegs = recovered.args.map((a) => a.reg);

  assert.deepEqual(argRegs, ['x0', 'x1', 'v0'], `expected ['x0', 'x1', 'v0'], got ${JSON.stringify(argRegs)}`);
  assert.deepEqual(recovered.args.map((a) => a.index), [0, 1, 2]);
  assert.equal(recovered.args[2].type, 'double');
});

test('type-recovery: AArch64 FP unary conversions scvtf/ucvtf/fcvtzs/fcvtzu score source and dst sides independently', () => {
  const mkVal = (id, reg, bits = 64) => ({ id, reg, bits, uses: [], def: null });
  const aSigned = mkVal(1, 'x0', 64);
  const dFromS = mkVal(2, 'd0', 64);
  const aUnsigned = mkVal(3, 'x1', 64);
  const dFromU = mkVal(4, 'd1', 64);
  const fForS = mkVal(5, 'v0', 64);
  const iFromF = mkVal(6, 'x2', 64);
  const fForU = mkVal(7, 'v1', 64);
  const uFromF = mkVal(8, 'x3', 64);
  const fNarrow = mkVal(9, 's2', 32);
  const fWide = mkVal(10, 'd2', 64);

  const insts = [
    { id: 100, row: 0, block: 0, op: OP.UN, sub: 'scvtf', args: [{ value: aSigned }], dst: dFromS },
    { id: 101, row: 1, block: 0, op: OP.UN, sub: 'ucvtf', args: [{ value: aUnsigned }], dst: dFromU },
    { id: 102, row: 2, block: 0, op: OP.UN, sub: 'fcvtzs', args: [{ value: fForS }], dst: iFromF },
    { id: 103, row: 3, block: 0, op: OP.UN, sub: 'fcvtzu', args: [{ value: fForU }], dst: uFromF },
    { id: 104, row: 4, block: 0, op: OP.UN, sub: 'fcvt', args: [{ value: fNarrow }], dst: fWide },
    { id: 105, row: 5, block: 0, op: OP.RET, args: [{ value: iFromF }] },
  ];
  dFromS.def = insts[0]; aSigned.uses.push(insts[0]);
  dFromU.def = insts[1]; aUnsigned.uses.push(insts[1]);
  iFromF.def = insts[2]; fForS.uses.push(insts[2]);
  uFromF.def = insts[3]; fForU.uses.push(insts[3]);
  fWide.def = insts[4]; fNarrow.uses.push(insts[4]);
  iFromF.uses.push(insts[5]);

  const ir = {
    blocks: [{ id: 0, succs: [], preds: [] }],
    instructions: insts,
    values: [aSigned, dFromS, aUnsigned, dFromU, fForS, iFromF, fForU, uFromF, fNarrow, fWide],
    args: new Map(),
    stackSlots: [],
    locations: new Map(),
  };

  const recovered = inferSemanticTypes(ir, {});
  assert.equal(recovered.values.get(aSigned.id).name, 'int64');
  assert.equal(recovered.values.get(dFromS.id).name, 'double');
  assert.equal(recovered.values.get(aUnsigned.id).name, 'uint64');
  assert.equal(recovered.values.get(dFromU.id).name, 'double');
  assert.equal(recovered.values.get(fForS.id).name, 'double');
  assert.equal(recovered.values.get(iFromF.id).name, 'int64');
  assert.equal(recovered.values.get(fForU.id).name, 'double');
  assert.equal(recovered.values.get(uFromF.id).name, 'uint64');
  assert.equal(recovered.values.get(fNarrow.id).name, 'float');
  assert.equal(recovered.values.get(fWide.id).name, 'double');
});
