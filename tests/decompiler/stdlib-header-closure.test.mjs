import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  closeFunctionOutput,
  STANDARD_C_LIBRARY_HEADERS,
} from '../../js/decompiler/c-output-closure.js';
import { buildCTranslationUnit } from '../../js/analysis/query/translation-unit.js';

const AARCH64_GCC = (() => {
  for (const cc of ['aarch64-linux-gnu-gcc', 'gcc', 'clang']) {
    try {
      execFileSync(cc, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
      return cc;
    } catch { /* try next */ }
  }
  return null;
})();

const HARNESS_STDLIB_PREAMBLE = [
  '#include <stdlib.h>',
  '#include <string.h>',
  '#include <math.h>',
  '#include <stdio.h>',
  '#include <ctype.h>',
  '',
].join('\n');

function compileSyntaxOnly(code, label = '') {
  assert.ok(AARCH64_GCC, 'expected aarch64-linux-gnu-gcc (or gcc/clang) to be installed');
  try {
    execFileSync(AARCH64_GCC, ['-x', 'c', '-fsyntax-only', '-'], {
      input: code,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = String(err.stderr || err.message || '');
    assert.fail(`${label}: ${AARCH64_GCC} -fsyntax-only failed:\n${code}\n--- stderr ---\n${stderr}`);
  }
}

function makeResult(lines) {
  return {
    lines,
    pseudocode: lines.map((l) => `${'    '.repeat(l.indent || 0)}${l.text}`).join('\n'),
  };
}

test('stdlib calls emit deduplicated standard #include headers, zero __HEX_ANY_ARGS prototypes, and compile standalone + with harness headers', () => {
  const sigSource = { addresses: [0x1000n], rows: [0] };
  const result = makeResult([
    { kind: 'sig', indent: 0, text: 'int process_buf(const char * s, double x, float y)', row: 0, addr: 0x1000n, source: sigSource },
    { kind: 'ctrl', indent: 0, text: '{', row: 0, addr: 0x1000n, source: sigSource },
    { kind: 'stmt', indent: 1, text: 'size_t n = strlen(s);' },
    { kind: 'stmt', indent: 1, text: 'char * buf = (char *)malloc(n + 1);' },
    { kind: 'stmt', indent: 1, text: 'memcpy(buf, s, n + 1);' },
    { kind: 'stmt', indent: 1, text: 'char * hit = strchr(buf, tolower((unsigned char)buf[0]));' },
    { kind: 'stmt', indent: 1, text: 'long v = strtol(hit ? hit : buf, NULL, 10);' },
    { kind: 'stmt', indent: 1, text: 'int a = abs((int)v);' },
    { kind: 'stmt', indent: 1, text: 'double d = fabs(x) + (double)sqrtf(y);' },
    { kind: 'stmt', indent: 1, text: 'printf("%d %f\\n", a, d);' },
    { kind: 'stmt', indent: 1, text: 'free(buf);' },
    { kind: 'ctrl', indent: 1, text: 'return a;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(result);

  for (const header of ['<ctype.h>', '<math.h>', '<stdio.h>', '<stdlib.h>', '<string.h>']) {
    assert.equal(
      result.pseudocode.split(`#include ${header}`).length - 1,
      1,
      `expected exactly one #include ${header}`,
    );
  }

  for (const fn of ['malloc', 'free', 'strlen', 'memcpy', 'strchr', 'strtol', 'sqrtf', 'fabs', 'abs', 'tolower', 'printf']) {
    assert.ok(STANDARD_C_LIBRARY_HEADERS.has(fn), `${fn} should be in STANDARD_C_LIBRARY_HEADERS`);
    assert.doesNotMatch(
      result.pseudocode,
      new RegExp(`uint64\\s+${fn}\\s*\\(__HEX_ANY_ARGS\\)`),
      `must not emit standalone prototype for stdlib function ${fn}`,
    );
  }

  // No non-stdlib external calls and no __HEX_ANY_ARGS in body -> no __HEX_ANY_ARGS macro or comment.
  assert.doesNotMatch(result.pseudocode, /#define __HEX_ANY_ARGS/);
  assert.doesNotMatch(result.pseudocode, /standalone external prototypes/);

  // Idempotent on second pass.
  const once = result.pseudocode;
  const onceCount = result.lines.length;
  closeFunctionOutput(result);
  assert.equal(result.pseudocode, once);
  assert.equal(result.lines.length, onceCount);

  // Real compilation: standalone AND prepended with standard C headers.
  compileSyntaxOnly(result.pseudocode, 'standalone stdlib function');
  compileSyntaxOnly(HARNESS_STDLIB_PREAMBLE + result.pseudocode, 'harness-prepended stdlib function');
});

test('already-included headers are skipped and non-stdlib external calls still get __HEX_ANY_ARGS prototypes', () => {
  const result = makeResult([
    { kind: 'decl', indent: 0, text: '#include <stdlib.h>' },
    { kind: 'sig', indent: 0, text: 'uint64 mixed_stdlib_and_ext(void * p)', row: 0, addr: 0x2000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'x0 = (uint64)malloc(32);' },
    { kind: 'stmt', indent: 1, text: 'x1 = objc_retain(p);' },
    { kind: 'stmt', indent: 1, text: 'x2 = ext_fn(x0, x1);' },
    { kind: 'stmt', indent: 1, text: 'x3 = sub_1000(x2);' },
    { kind: 'stmt', indent: 1, text: 'free((void *)x0);' },
    { kind: 'ctrl', indent: 1, text: 'return x3;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(result);

  assert.equal(result.pseudocode.split('#include <stdlib.h>').length - 1, 1);
  assert.doesNotMatch(result.pseudocode, /uint64 malloc \(__HEX_ANY_ARGS\);/);
  assert.doesNotMatch(result.pseudocode, /uint64 free \(__HEX_ANY_ARGS\);/);
  assert.match(result.pseudocode, /#define __HEX_ANY_ARGS/);
  assert.match(result.pseudocode, /uint64 objc_retain \(__HEX_ANY_ARGS\);/);
  assert.match(result.pseudocode, /uint64 ext_fn \(__HEX_ANY_ARGS\);/);
  assert.match(result.pseudocode, /uint64 sub_1000 \(__HEX_ANY_ARGS\);/);

  compileSyntaxOnly(result.pseudocode, 'mixed stdlib and ext standalone');
  compileSyntaxOnly(HARNESS_STDLIB_PREAMBLE + result.pseudocode, 'mixed stdlib and ext with harness headers');
});

test('buildCTranslationUnit hoists and deduplicates stdlib headers across functions with zero conflicting prototypes', () => {
  const fn1 = makeResult([
    { kind: 'sig', indent: 0, text: 'int f_str(const char * s)', row: 0, addr: 0x100n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'size_t n = strlen(s);' },
    { kind: 'stmt', indent: 1, text: 'char * copy = (char *)malloc(n + 1);' },
    { kind: 'stmt', indent: 1, text: 'memcpy(copy, s, n + 1);' },
    { kind: 'stmt', indent: 1, text: 'int c = tolower((unsigned char)copy[0]);' },
    { kind: 'stmt', indent: 1, text: 'free(copy);' },
    { kind: 'ctrl', indent: 1, text: 'return c;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);
  const fn2 = makeResult([
    { kind: 'sig', indent: 0, text: 'int f_math(const char * s, double x, float y)', row: 0, addr: 0x200n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'char * p = strchr(s, 45);' },
    { kind: 'stmt', indent: 1, text: 'int v = abs((int)strtol(p ? p : s, NULL, 10));' },
    { kind: 'stmt', indent: 1, text: 'double m = fabs(x) + (double)sqrtf(y);' },
    { kind: 'stmt', indent: 1, text: 'printf("%d %f\\n", v, m);' },
    { kind: 'ctrl', indent: 1, text: 'return v;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(fn1);
  closeFunctionOutput(fn2);

  const unit = buildCTranslationUnit([
    {
      address: 0x100n,
      name: 'f_str',
      signature: 'int f_str(const char * s)',
      pseudocode: fn1.pseudocode,
      ir: {
        instructions: [
          { op: 'call', target: 0x9000n, name: 'strlen' },
          { op: 'call', target: 0x9004n, name: 'malloc' },
          { op: 'call', target: 0x9008n, name: 'memcpy' },
          { op: 'call', target: 0x900cn, name: 'tolower' },
          { op: 'call', target: 0x9010n, name: 'free' },
        ],
      },
    },
    {
      address: 0x200n,
      name: 'f_math',
      signature: 'int f_math(const char * s, double x, float y)',
      pseudocode: fn2.pseudocode,
      ir: {
        instructions: [
          { op: 'call', target: 0x9014n, name: 'strchr' },
          { op: 'call', target: 0x9018n, name: 'strtol' },
          { op: 'call', target: 0x901cn, name: 'abs' },
          { op: 'call', target: 0x9020n, name: 'fabs' },
          { op: 'call', target: 0x9024n, name: 'sqrtf' },
          { op: 'call', target: 0x9028n, name: 'printf' },
        ],
      },
    },
  ]);

  assert.equal(unit.functions[0].syntaxOnly, false, JSON.stringify(unit.unresolved));
  assert.equal(unit.functions[1].syntaxOnly, false, JSON.stringify(unit.unresolved));

  for (const header of ['<ctype.h>', '<math.h>', '<stdio.h>', '<stdlib.h>', '<string.h>']) {
    assert.ok(unit.includes.includes(header), `unit.includes missing ${header}`);
    assert.equal(
      unit.source.split(`#include ${header}`).length - 1,
      1,
      `expected exactly one #include ${header} at top of TU`,
    );
  }

  // Headers must appear before the first function definition and never inside bodies.
  const firstFnIdx = unit.source.indexOf('int f_str(');
  assert.ok(firstFnIdx > 0);
  assert.doesNotMatch(unit.source.slice(firstFnIdx), /#include\s*</);

  // Zero fallback uint64 / uint64_t prototypes for stdlib functions.
  for (const fn of ['malloc', 'free', 'strlen', 'memcpy', 'strchr', 'strtol', 'sqrtf', 'fabs', 'abs', 'tolower', 'printf']) {
    assert.doesNotMatch(unit.source, new RegExp(`uint64(?:_t)?\\s+${fn}\\s*\\(`));
  }

  compileSyntaxOnly(unit.source, 'TU standalone');
  compileSyntaxOnly(HARNESS_STDLIB_PREAMBLE + unit.source, 'TU with harness headers');
});
