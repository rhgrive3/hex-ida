import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInSandbox } from '../js/sandbox.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'js/sandbox.js'), 'utf8');

function loadControlNormalizers() {
  const start = SOURCE.indexOf('function normalizeSandboxIndex(');
  const end = SOURCE.indexOf('\n\nexport function runInSandbox', start);
  assert.ok(start >= 0 && end > start, 'sandbox control normalizers must remain extractable');
  const body = SOURCE.slice(start, end);
  return new Function(`${body}\nreturn { normalizeSandboxIndex, normalizeSandboxTimeout };`)();
}

function loadWorkerProgram() {
  const start = SOURCE.indexOf('function workerProgram(');
  const end = SOURCE.indexOf('\n\nconst FRAME =', start);
  assert.ok(start >= 0 && end > start, 'workerProgram must remain extractable');
  const body = SOURCE.slice(start, end);
  return new Function('WORKER_PRELUDE', 'WORKER_POSTLUDE', `return (${body});`)('', '');
}

const { normalizeSandboxIndex, normalizeSandboxTimeout } = loadControlNormalizers();
const workerProgram = loadWorkerProgram();

test('plugin index accepts only primitive non-negative safe integers', () => {
  assert.equal(normalizeSandboxIndex('plugin', 0), 0);
  assert.equal(normalizeSandboxIndex('plugin', 2), 2);
  assert.equal(normalizeSandboxIndex('plugin', Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);

  for (const value of [['1'], true, '1', 1.5, -1, Number.MAX_SAFE_INTEGER + 1, {}, new Number(1)]) {
    assert.equal(normalizeSandboxIndex('plugin', value), null, `must reject ${String(value)}`);
  }
});

test('non-plugin modes do not transport irrelevant caller index values', () => {
  assert.equal(normalizeSandboxIndex('script', ['1']), 0);
  assert.equal(normalizeSandboxIndex('discover', true), 0);
});

test('timeout accepts only positive safe-integer numbers and preserves the 50 ms floor', () => {
  assert.equal(normalizeSandboxTimeout(1), 50);
  assert.equal(normalizeSandboxTimeout(49), 50);
  assert.equal(normalizeSandboxTimeout(50), 50);
  assert.equal(normalizeSandboxTimeout(30000), 30000);
  assert.equal(normalizeSandboxTimeout(2_147_483_647), 2_147_483_647);
  assert.equal(normalizeSandboxTimeout(Number.MAX_SAFE_INTEGER), 2_147_483_647);

  for (const value of [['50'], true, '50', 1.5, 0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}, new Number(50)]) {
    assert.equal(normalizeSandboxTimeout(value), null, `must reject ${String(value)}`);
  }
});

test('worker-side plugin selection does not coerce a structured index', () => {
  assert.match(workerProgram('', 'plugin', 1), /const def = defs\[1\];/);
  assert.match(workerProgram('', 'plugin', ['1']), /const def = defs\[-1\];/);
  assert.match(workerProgram('', 'plugin', true), /const def = defs\[-1\];/);
  assert.match(workerProgram('', 'plugin', 1.5), /const def = defs\[-1\];/);
});

test('runInSandbox rejects malformed plugin index before allocating browser resources', async () => {
  let coercions = 0;
  const hostile = {
    valueOf() { coercions++; return 1; },
    toString() { coercions++; return '1'; },
  };

  for (const index of [['1'], true, '1', 1.5, -1, hostile]) {
    const result = await runInSandbox({
      source: '',
      mode: 'plugin',
      index,
      api: {},
      out() {},
      timeout: 100,
    });
    assert.equal(result.error, 'プラグイン定義番号が無効です。');
  }
  assert.equal(coercions, 0, 'invalid index must not invoke caller coercion hooks');
});

test('runInSandbox rejects malformed timeout before allocating browser resources', async () => {
  let coercions = 0;
  const hostile = {
    valueOf() { coercions++; return 50; },
    toString() { coercions++; return '50'; },
  };

  for (const timeout of [['50'], true, '50', 1.5, 0, -1, NaN, Infinity, hostile]) {
    const result = await runInSandbox({
      source: '',
      mode: 'script',
      api: {},
      out() {},
      timeout,
    });
    assert.equal(result.error, '実行時間制限が無効です。');
  }
  assert.equal(coercions, 0, 'invalid timeout must not invoke caller coercion hooks');
});
