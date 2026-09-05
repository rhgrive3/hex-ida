import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(ROOT, 'js/sandbox.js'), 'utf8');
const instrumented = `${source}\nexport { sandboxIndex as __sandboxIndexForTest, sandboxTimeout as __sandboxTimeoutForTest, workerProgram as __workerProgramForTest };`;
const mod = await import(`data:text/javascript;base64,${Buffer.from(instrumented).toString('base64')}`);

const base = { source: '', mode: 'plugin', api: {}, out() {} };

test('plugin index accepts only canonical non-negative safe-integer numbers', async () => {
  assert.equal(mod.__sandboxIndexForTest(0), 0);
  assert.equal(mod.__sandboxIndexForTest(7), 7);
  for (const value of [['1'], true, '1', 1.5, -1, Number.MAX_SAFE_INTEGER + 1, {}, null]) {
    assert.equal(mod.__sandboxIndexForTest(value), null);
    const result = await mod.runInSandbox({ ...base, index: value, timeout: 30000 });
    assert.match(result.error, /プラグイン番号/);
  }
});

test('timeout accepts only positive finite safe-integer numbers and preserves the 50ms floor', async () => {
  assert.equal(mod.__sandboxTimeoutForTest(1), 50);
  assert.equal(mod.__sandboxTimeoutForTest(50), 50);
  assert.equal(mod.__sandboxTimeoutForTest(30000), 30000);
  for (const value of [['50'], true, '50', 1.5, 0, -1, Infinity, Number.MAX_SAFE_INTEGER + 1, {}, null]) {
    assert.equal(mod.__sandboxTimeoutForTest(value), null);
    const result = await mod.runInSandbox({ ...base, index: 0, timeout: value });
    assert.match(result.error, /実行時間制限/);
  }
});

test('worker-side defense does not Number-coerce malformed plugin indexes', () => {
  const malformed = mod.__workerProgramForTest('', 'plugin', ['1']);
  assert.match(malformed, /const __hexUserIndex = -1;/);
  const canonical = mod.__workerProgramForTest('', 'plugin', 1);
  assert.match(canonical, /const __hexUserIndex = 1;/);
});
