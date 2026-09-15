import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInSandbox } from '../js/sandbox.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'js/sandbox.js'), 'utf8');

function loadWorkerProgram() {
  const start = SOURCE.indexOf('function workerProgram(');
  const end = SOURCE.indexOf('\n\nconst FRAME =', start);
  assert.ok(start >= 0 && end > start, 'workerProgram must remain extractable');
  const body = SOURCE.slice(start, end);
  return new Function('WORKER_PRELUDE', 'WORKER_POSTLUDE', `return (${body});`)('', '');
}

function setGlobal(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  };
}

const workerProgram = loadWorkerProgram();

test('workerProgram rejects structured source without invoking coercion hooks', () => {
  let coercions = 0;
  const hostile = {
    valueOf() { coercions++; return 'print("valueOf")'; },
    toString() { coercions++; return 'print("toString")'; },
  };

  for (const source of [[], ['print("array")'], {}, new String('print("boxed")'), hostile]) {
    assert.throws(() => workerProgram(source, 'script', 0), /source/i);
  }
  assert.equal(coercions, 0, 'source validation must not execute caller coercion hooks');
});

test('workerProgram rejects malformed execution modes instead of falling back to script', () => {
  for (const mode of [['plugin'], {}, new String('plugin'), 'unknown', '', 0, true, null]) {
    assert.throws(() => workerProgram('print("must-not-run")', mode, 0), /mode/i);
  }

  assert.doesNotThrow(() => workerProgram('', 'script', 0));
  assert.doesNotThrow(() => workerProgram('', 'discover', 0));
  assert.doesNotThrow(() => workerProgram('', 'plugin', 0));
});

test('runInSandbox rejects malformed source before allocating browser resources or coercing input', async () => {
  let created = 0;
  let coercions = 0;
  const restoreDocument = setGlobal('document', {
    createElement() {
      created++;
      throw new Error('browser resources must not be allocated for invalid source');
    },
  });
  const hostile = {
    valueOf() { coercions++; return 'print("valueOf")'; },
    toString() { coercions++; return 'print("toString")'; },
  };

  try {
    for (const source of [[], ['print("array")'], {}, new String('print("boxed")'), hostile, null, undefined]) {
      const result = await runInSandbox({ source, mode: 'script', api: {}, out() {}, timeout: 100 });
      assert.equal(result.error, '実行ソースが無効です。');
    }
    assert.equal(created, 0);
    assert.equal(coercions, 0, 'invalid source must not execute caller coercion hooks');
  } finally {
    restoreDocument();
  }
});

test('runInSandbox rejects malformed mode before allocating browser resources', async () => {
  let created = 0;
  let coercions = 0;
  const restoreDocument = setGlobal('document', {
    createElement() {
      created++;
      throw new Error('browser resources must not be allocated for invalid mode');
    },
  });
  const hostile = {
    valueOf() { coercions++; return 'plugin'; },
    toString() { coercions++; return 'plugin'; },
  };

  try {
    for (const mode of [['plugin'], {}, new String('plugin'), hostile, 'unknown', '', 0, true, null]) {
      const result = await runInSandbox({ source: '', mode, index: ['1'], api: {}, out() {}, timeout: 100 });
      assert.equal(result.error, '実行モードが無効です。');
    }
    assert.equal(created, 0);
    assert.equal(coercions, 0, 'invalid mode must not execute caller coercion hooks');
  } finally {
    restoreDocument();
  }
});
