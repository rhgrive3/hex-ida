import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderNZCVCondition } from '../../js/decompiler/flag-semantics.js';

test('renderNZCVCondition parenthesizes compound bitwise left/right operands inside comparisons', () => {
  const cond = renderNZCVCondition('sub', 'ls', '((((uint8_t *)(uintptr_t)(a1))[phi_403]) - 97) & 0xFF', '25', 32);
  assert.ok(cond, 'condition should render');
  // Must parenthesize the bitwise `& 0xFF` before `<= 25` so C does not parse `x & (0xFF <= 25)`.
  assert.doesNotMatch(cond, /& 0xFF <= 25/);
  assert.match(cond, /\(.*& 0xFF\)\s*<=\s*25/);

  // Compile and execute the generated C expression on 'a' (97 -> 0 <= 25: true) and 'A' (65 -> 224 <= 25: false).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-flag-prec-'));
  try {
    const src = path.join(dir, 'test.c');
    const bin = path.join(dir, 'test');
    fs.writeFileSync(src, `
#include <stdint.h>
#include <assert.h>
static int check(const uint8_t *a1, int phi_403) {
  return (${cond}) ? 1 : 0;
}
int main(void) {
  const uint8_t s[] = "aAzZ0";
  assert(check(s, 0) == 1);
  assert(check(s, 1) == 0);
  assert(check(s, 2) == 1);
  assert(check(s, 3) == 0);
  assert(check(s, 4) == 0);
  return 0;
}
`);
    execFileSync('gcc', ['-O0', '-Wall', '-Wextra', src, '-o', bin], { stdio: 'pipe' });
    execFileSync(bin, [], { stdio: 'pipe' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renderNZCVCondition keeps simple atomic operands unparenthesized', () => {
  const cond = renderNZCVCondition('sub', 'le', 'a2', '0', 32);
  assert.equal(cond, '(int32_t)a2 <= 0');
});
