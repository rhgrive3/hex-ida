import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  closeFunctionOutput,
  declarationBearingSource,
  inferPointerTypedLocals,
  scanIdentifierUses,
} from '../../js/decompiler/c-output-closure.js';

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
    execFileSync(CC, ['-x', 'c', '-fsyntax-only', '-Werror=int-conversion', '-'], {
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

test('1. inferPointerTypedLocals detects paired-line assignments and excludes -, %, [ uses', () => {
  const body = `{
    var_8 = 0x100ECDFD8 + 16;   var_10 = cond != 0 ? "yes" : "no";
    p_sub = a1;
    z1 = p_sub - 8;
    p_mod = a1;
    z2 = p_mod % 16;
    p_idx = a1;
    z3 = p_idx[0];
}`;
  const inferred = inferPointerTypedLocals(body, 'uint64 fn(void * a1)');
  assert.equal(inferred.has('var_10'), true, 'paired-line var_10 should be inferred as pointer');
  assert.equal(inferred.has('p_sub'), false, 'subtracted local must not be promoted to const void *');
  assert.equal(inferred.has('p_mod'), false, 'modulo local must not be promoted to const void *');
  assert.equal(inferred.has('p_idx'), false, 'subscripted local must not be promoted to const void *');

  const sigSource = { addresses: [0x10006f9a8n], rows: [0] };
  const res = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 sub_10006F9A8(void * a1)', row: 0, addr: 0x10006f9a8n, source: sigSource },
    { kind: 'ctrl', indent: 0, text: '{', row: 0, addr: 0x10006f9a8n, source: sigSource },
    { kind: 'stmt', indent: 1, text: 'x20 = a1;', row: 1, addr: 0x10006f9acn, source: { addresses: [0x10006f9acn], rows: [1] } },
    { kind: 'stmt', indent: 1, text: 'var_8 = 0x100ECDFD8 + 16;   var_10 = (uint32)*(uint8 *)(*(uint64 *)(*(uint64 *)(a1 + 8)) + 16) != 0 ? "\\"\\\\bfnrte" : "\\"\\\\bfnrt";', row: 2, addr: 0x10006f9b0n, source: { addresses: [0x10006f9b0n], rows: [2] } },
    { kind: 'stmt', indent: 1, text: 'x20 = x19;', row: 3, addr: 0x10006f9b4n },
    { kind: 'stmt', indent: 1, text: 'x19 = *(uint64 *)(x20 + 8);', row: 4, addr: 0x10006f9b8n },
    { kind: 'ctrl', indent: 1, text: 'return x19;', row: 5, addr: 0x10006f9bcn },
    { kind: 'ctrl', indent: 0, text: '}', row: 6, addr: 0x10006f9c0n },
  ]);

  closeFunctionOutput(res);
  assert.match(res.pseudocode, /const void \* var_10;/);
  assert.match(res.pseudocode, /x20 = \(uintptr_t\)\(a1\);/);
  // Provenance on rewritten body line must remain intact.
  const rewrittenLine = res.lines.find((l) => l.text.includes('x20 = (uintptr_t)(a1);'));
  assert.ok(rewrittenLine?.source?.addresses?.includes(0x10006f9acn));
  assertStrictCSyntax(res.pseudocode, 'KartPad 0x10006f9a8 paired-line + mixed pointer');
  assertIdempotent(res, 'KartPad 0x10006f9a8');
});

test('2. Layer A: ObjC method signatures and [receiver sel:...] selectors never fabricate uint64 locals', () => {
  const res = makeResult([
    { kind: 'sig', indent: 0, text: 'id -[SettingsVC applyTheme](void)', row: 0, addr: 0x1000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'x0 = [NSUserDefaults standardUserDefaults];' },
    { kind: 'stmt', indent: 1, text: 'x1 = [x0 setDarkMode:x2 forKey:x3];' },
    { kind: 'stmt', indent: 1, text: 'x4 = [[NSUserDefaults standardUserDefaults] setObject:val forKey:@"k"];' },
    { kind: 'stmt', indent: 1, text: 'x5 = [x0 setFlag:cond ? a : b forKey:k];' },
    { kind: 'stmt', indent: 1, text: 'x6 = [player addCoins:amount];' },
    { kind: 'stmt', indent: 1, text: 'x7 = [self adRequest];' },
    { kind: 'stmt', indent: 1, text: 'foo = [x0 foo:x2];' },
    { kind: 'ctrl', indent: 1, text: 'return x0;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(res);
  // Selector tokens must NOT be declared as locals.
  for (const sel of ['applyTheme', 'SettingsVC', 'standardUserDefaults', 'setDarkMode', 'forKey', 'setObject', 'setFlag', 'addCoins', 'adRequest']) {
    assert.doesNotMatch(res.pseudocode, new RegExp(`\\buint64 ${sel};`), `fake local declared for ObjC selector ${sel}`);
  }
  // Real values (including `foo`, which is used both as a selector and as an LHS variable) MUST be declared.
  for (const v of ['x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'val', 'cond', 'a', 'b', 'k', 'player', 'amount', 'self', 'foo']) {
    assert.match(res.pseudocode, new RegExp(`\\b${v};`), `expected local declaration for ${v}`);
  }
  // Display syntax must remain completely unchanged.
  assert.match(res.pseudocode, /\[player addCoins:amount\]/);
  assert.match(res.pseudocode, /\[self adRequest\]/);
  assert.match(res.pseudocode, /\[x0 setDarkMode:x2 forKey:x3\]/);
  assertIdempotent(res, 'ObjC Layer A');
});

test('3. Scanner precision: # preproc blanking, escaped newline preservation, subscriptBase uint8_t *, C namespaces, and a * b;', () => {
  // 3a. declarationBearingSource: preprocessor lines & escaped newlines
  const rawSrc = '#define MY_MACRO 123\n#define MULTI(x) \\\n  (x + 1)\nconst char *s = "line1\\\nline2";\nx = 1;\n';
  const cleaned = declarationBearingSource(rawSrc);
  assert.equal(cleaned.split('\n').length, rawSrc.split('\n').length, 'newline count must be preserved');
  assert.doesNotMatch(cleaned, /\bMY_MACRO\b/);
  assert.doesNotMatch(cleaned, /\bMULTI\b/);
  assert.match(cleaned, /\bx\b/);

  // 3b. subscriptBase (`memory[...]` and pure subscript base `buf[...]`) -> uint8_t *
  const memRes = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 read_mem(uint64 idx)', row: 0, addr: 0x2000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'load_1 = memory[idx + 8];' },
    { kind: 'stmt', indent: 1, text: 'load_2 = buf[idx];' },
    { kind: 'ctrl', indent: 1, text: 'return load_1 + load_2;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(memRes);
  assert.match(memRes.pseudocode, /uint8_t \* memory;/);
  assert.match(memRes.pseudocode, /uint8_t \* buf;/);
  assertStrictCSyntax(memRes.pseudocode, 'subscriptBase uint8_t *');
  assertIdempotent(memRes, 'subscriptBase');

  // 3c. Separate C namespaces: local variable sharing name with memberName / label / tag
  const nsRes = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 namespaces(void)', row: 0, addr: 0x2100n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'struct tag_x *tp;' },
    { kind: 'stmt', indent: 1, text: 'tag_x = 1;' },
    { kind: 'stmt', indent: 1, text: 'field_a = obj->field_a + tag_x;' },
    { kind: 'stmt', indent: 1, text: 'retry:' },
    { kind: 'stmt', indent: 1, text: 'retry = field_a + 1;' },
    { kind: 'stmt', indent: 1, text: 'if (retry == 0) goto retry;' },
    { kind: 'ctrl', indent: 1, text: 'return retry;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(nsRes);
  assert.match(nsRes.pseudocode, /\buint64 tag_x;/);
  assert.match(nsRes.pseudocode, /\buint64 field_a;/);
  assert.match(nsRes.pseudocode, /\buint64 retry;/);
  assertStrictCSyntax(nsRes.pseudocode, 'separate C namespaces');
  assertIdempotent(nsRes, 'separate C namespaces');

  // 3d. Multiplication statement `a * b;` must not suppress local declarations
  const mulRes = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 mul_stmt(void)', row: 0, addr: 0x2200n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'a * b;' },
    { kind: 'ctrl', indent: 1, text: 'return a + b;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(mulRes);
  assert.match(mulRes.pseudocode, /\buint64 a;/);
  assert.match(mulRes.pseudocode, /\buint64 b;/);
  assertStrictCSyntax(mulRes.pseudocode, 'multiplication statement a * b;');
  assertIdempotent(mulRes, 'multiplication statement');
});

test('4. -Werror=int-conversion: int<->ptr assignments, pre-declared stack locals, returns, and mixed ternaries', () => {
  // 4a. KartPad 0x100047ba4 pattern: &var_20 into uint64 with arithmetic + pre-declared uint64 var_10
  const assignRes = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 sub_100047BA4(void * a1, int64 a2, int64 a3, uint64 a4, int64 a5)', row: 0, addr: 0x100047ba4n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'decl', indent: 1, text: 'uint64 var_20;' },
    { kind: 'decl', indent: 1, text: 'uint64 var_10;' },
    { kind: 'decl', indent: 1, text: 'uint64 var_8;' },
    { kind: 'stmt', indent: 1, text: 'x23 = a3;' },
    { kind: 'stmt', indent: 1, text: 'x24 = &var_20;' },
    { kind: 'stmt', indent: 1, text: '*(uint8 *)(x24 + a3) = 0;' },
    { kind: 'stmt', indent: 1, text: 'x23 = &var_8;' },
    { kind: 'stmt', indent: 1, text: '*(uint8 *)(x23 + a5) = 0;' },
    { kind: 'stmt', indent: 1, text: 'var_8 = 0x10;   var_10 = a2 != 0 ? "strA" : "strB";' },
    { kind: 'stmt', indent: 1, text: 'a1 = x24 + 8;' },
    { kind: 'stmt', indent: 1, text: 'a1 = 0;' },
    { kind: 'stmt', indent: 1, text: 'x25 = a2 ? "hello" : a4;' },
    { kind: 'stmt', indent: 1, text: 'x26 = a2 ? a1 : 1;' },
    { kind: 'ctrl', indent: 1, text: 'return a1;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(assignRes);
  assert.match(assignRes.pseudocode, /typedef __UINTPTR_TYPE__ uintptr_t;/);
  assert.match(assignRes.pseudocode, /x24 = \(uintptr_t\)\(&var_20\);/);
  assert.match(assignRes.pseudocode, /var_10 = \(uintptr_t\)\(a2 != 0 \? "strA" : "strB"\);/);
  assert.match(assignRes.pseudocode, /a1 = \(void \*\)\(uintptr_t\)\(x24 \+ 8\);/);
  assert.match(assignRes.pseudocode, /a1 = 0;/);
  assert.match(assignRes.pseudocode, /x25 = a2 \? \(uintptr_t\)\("hello"\) : a4;/);
  assert.match(assignRes.pseudocode, /x26 = a2 \? \(uintptr_t\)\(a1\) : 1;/);
  assert.match(assignRes.pseudocode, /return \(uintptr_t\)\(a1\);/);
  assertStrictCSyntax(assignRes.pseudocode, 'int<->ptr assignments + mixed ternary + int return');
  assertIdempotent(assignRes, 'int<->ptr assignments');

  // 4b. Pointer-returning functions (id, void *, MyObj *) returning uint64 / call_N / 0
  const ptrRetRes = makeResult([
    { kind: 'sig', indent: 0, text: 'id method_ret(id self, void * a2, uint64 flag)', row: 0, addr: 0x3000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'x8 = a2;' },
    { kind: 'stmt', indent: 1, text: 'x0 = objc_retain(self);' },
    { kind: 'stmt', indent: 1, text: 'if (flag == 0) return 0;' },
    { kind: 'stmt', indent: 1, text: 'if (flag == 1) return objc_autorelease(self);' },
    { kind: 'ctrl', indent: 1, text: 'return x0;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  closeFunctionOutput(ptrRetRes);
  assert.match(ptrRetRes.pseudocode, /if \(flag == 0\) return 0;/);
  assert.match(ptrRetRes.pseudocode, /return \(id\)\(uintptr_t\)\(objc_autorelease\(self\)\);/);
  assert.match(ptrRetRes.pseudocode, /return \(id\)\(uintptr_t\)\(x0\);/);
  assertStrictCSyntax(ptrRetRes.pseudocode, 'id return coercion');
  assertIdempotent(ptrRetRes, 'id return coercion');
});

test('5. -Werror=int-conversion: GCC LP64 size_t built-ins cast integer pointer arguments cleanly', () => {
  const res = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 builtin_calls(uint64 s1, uint64 s2, uint64 n, uint64 fp)', row: 0, addr: 0x4000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'r0 = strlen(s1);' },
    { kind: 'stmt', indent: 1, text: 'r1 = strnlen(s1, n);' },
    { kind: 'stmt', indent: 1, text: 'r2 = strspn(s1, s2);' },
    { kind: 'stmt', indent: 1, text: 'r3 = strcspn(s1, s2);' },
    { kind: 'stmt', indent: 1, text: 'r4 = fread(s1, 1, n, fp);' },
    { kind: 'stmt', indent: 1, text: 'r5 = fwrite(s1, 1, n, fp);' },
    { kind: 'stmt', indent: 1, text: 'r6 = wcslen(s1);' },
    { kind: 'stmt', indent: 1, text: 'r7 = strxfrm(s1, s2, n);' },
    { kind: 'stmt', indent: 1, text: 'r8 = mbstowcs(s1, s2, n);' },
    { kind: 'stmt', indent: 1, text: 'r9 = wcstombs(s1, s2, n);' },
    { kind: 'stmt', indent: 1, text: 'r10 = strftime(s1, n, s2, fp);' },
    { kind: 'ctrl', indent: 1, text: 'return r0 + r1 + r2 + r3 + r4 + r5 + r6 + r7 + r8 + r9 + r10;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(res);
  assert.match(res.pseudocode, /strlen\(\(const char \*\)\(uintptr_t\)\(s1\)\)/);
  assert.match(res.pseudocode, /fread\(\(void \*\)\(uintptr_t\)\(s1\), 1, n, \(void \*\)\(uintptr_t\)\(fp\)\)/);
  assert.match(res.pseudocode, /fwrite\(\(const void \*\)\(uintptr_t\)\(s1\), 1, n, \(void \*\)\(uintptr_t\)\(fp\)\)/);
  assert.match(res.pseudocode, /strftime\(\(char \*\)\(uintptr_t\)\(s1\), n, \(const char \*\)\(uintptr_t\)\(s2\), \(const void \*\)\(uintptr_t\)\(fp\)\)/);
  assertStrictCSyntax(res.pseudocode, 'LP64 size_t built-ins');
  assertIdempotent(res, 'LP64 size_t built-ins');
});
