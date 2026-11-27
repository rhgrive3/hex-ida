import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { closeFunctionOutput } from '../../js/decompiler/c-output-closure.js';

function makeResult(lines) {
  return {
    lines,
    pseudocode: lines.map((l) => `${'    '.repeat(l.indent || 0)}${l.text}`).join('\n'),
  };
}

function compileAndRunAarch64(cSource, label = 'aarch64-test') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-memory-init-test-'));
  const srcPath = path.join(tmpDir, 'test.c');
  const binPath = path.join(tmpDir, 'test.bin');
  try {
    fs.writeFileSync(srcPath, cSource, 'utf8');
    execFileSync('aarch64-linux-gnu-gcc', ['-O0', '-Wall', '-Wextra', '-o', binPath, srcPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const qemuArgs = fs.existsSync('/usr/aarch64-linux-gnu/lib')
      ? ['-L', '/usr/aarch64-linux-gnu', binPath]
      : [binPath];
    const stdout = execFileSync('qemu-aarch64', qemuArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return stdout.trim();
  } catch (err) {
    const stderr = String(err.stderr || err.message || '');
    const stdout = String(err.stdout || '');
    assert.fail(`${label} failed:\n--- C source ---\n${cSource}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('memory subscript closure initializes uint8_t * memory = (uint8_t *)0, is idempotent, and reads real buffer bytes under qemu-aarch64 without SIGSEGV', () => {
  const sigSource = { addresses: [0x1000n], rows: [0] };
  const result = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 sum_memory_bytes(const void * buf, uint64 len)', row: 0, addr: 0x1000n, source: sigSource },
    { kind: 'ctrl', indent: 0, text: '{', row: 0, addr: 0x1000n, source: sigSource },
    { kind: 'stmt', indent: 1, text: 'uint64 total = 0;' },
    { kind: 'stmt', indent: 1, text: 'for (uint64 i = 0; i < len; i++) {' },
    { kind: 'stmt', indent: 2, text: 'total += memory[(uintptr_t)buf + i];' },
    { kind: 'stmt', indent: 1, text: '}' },
    { kind: 'ctrl', indent: 1, text: 'return total;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(result);

  assert.match(result.pseudocode, /uint8_t \* memory = \(uint8_t \*\)0;/);
  assert.doesNotMatch(result.pseudocode, /uint8_t \* memory;/);

  // Strictly idempotent on second pass.
  const once = result.pseudocode;
  const onceLines = result.lines.length;
  closeFunctionOutput(result);
  assert.equal(result.pseudocode, once);
  assert.equal(result.lines.length, onceLines);

  // Compile + link + execute under qemu-aarch64 reading real buffer bytes via memory[(uintptr_t)buf + i].
  const harness = `
#include <stdio.h>
${result.pseudocode}
int main(void) {
  const uint8_t data[5] = { 10, 20, 30, 40, 50 };
  uint64 s = sum_memory_bytes(data, 5);
  printf("%llu\\n", (unsigned long long)s);
  return s == 150ULL ? 0 : 1;
}
`;
  const out = compileAndRunAarch64(harness, 'memory-init-buffer-read');
  assert.equal(out, '150');
});

test('memory[a1 + phi_idx] integer-address form and extern global_<HEX> contract both compile, link, and execute under qemu-aarch64', () => {
  const result = makeResult([
    { kind: 'sig', indent: 0, text: 'uint64 read_at_addr_plus_global(uint64 a1, uint64 phi_idx)', row: 0, addr: 0x2000n },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'uint64 b = memory[a1 + phi_idx];' },
    { kind: 'ctrl', indent: 1, text: 'return b + global_B10;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ]);

  closeFunctionOutput(result);

  assert.match(result.pseudocode, /uint8_t \* memory = \(uint8_t \*\)0;/);
  assert.match(result.pseudocode, /static uint64 global_B10 = 0;/);

  // Strictly idempotent on second pass.
  const once = result.pseudocode;
  closeFunctionOutput(result);
  assert.equal(result.pseudocode, once);

  const harness = `
#include <stdint.h>
#include <stdio.h>
${result.pseudocode}
int main(void) {
  global_B10 = 100ULL;
  const uint8_t buf[4] = { 3, 7, 11, 19 };
  uint64 r = read_at_addr_plus_global((uint64)(uintptr_t)buf, 2ULL);
  printf("%llu\\n", (unsigned long long)r);
  return r == 111ULL ? 0 : 1;
}
`;
  const out = compileAndRunAarch64(harness, 'memory-int-addr-and-extern-global');
  assert.equal(out, '111');
});
