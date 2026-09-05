import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INPUT_BUDGET = 4 * 1024 * 1024;

function loadEstimators() {
  const source = fs.readFileSync(path.join(ROOT, 'js/sandbox.js'), 'utf8');
  const workerMatch = source.match(/  const measure = \(value, seen = new Set\(\), limit = MAX_ARGUMENT_UNITS \+ 1\) => \{[\s\S]*?\n  \};\n\n  const rpc/);
  const hostMatch = source.match(/function valueSize\(value, seen = new Set\(\), limit = MAX_RPC_OUTPUT_BYTES \+ 1\) \{[\s\S]*?\n\}\n\nfunction sandboxOutputSize/);
  assert.ok(workerMatch, 'worker RPC estimator must remain extractable');
  assert.ok(hostMatch, 'host RPC estimator must remain extractable');

  const workerBody = workerMatch[0].replace(/\n\n  const rpc$/, '');
  const hostBody = hostMatch[0].replace(/\n\nfunction sandboxOutputSize$/, '');
  const measure = new Function(
    `const MAX_ARGUMENT_UNITS = ${INPUT_BUDGET};\n`
      + 'const nativeArrayIsArray = Array.isArray.bind(Array);\n'
      + 'const nativeArrayBufferIsView = ArrayBuffer.isView.bind(ArrayBuffer);\n'
      + 'const nativeKeys = Object.keys.bind(Object);\n'
      + `${workerBody}\nreturn measure;`,
  )();
  const valueSize = new Function(
    `const MAX_RPC_OUTPUT_BYTES = ${16 * 1024 * 1024};\n${hostBody}\nreturn valueSize;`,
  )();
  return { measure, valueSize };
}

const { measure, valueSize } = loadEstimators();

function oversizedKeyObject() {
  return { ['k'.repeat(Math.floor(INPUT_BUDGET / 2) + 64)]: null };
}

function oversizedKeyArray() {
  const value = [];
  value['k'.repeat(Math.floor(INPUT_BUDGET / 2) + 64)] = null;
  return value;
}

test('worker and host reject an RPC object whose property names exceed 4 MiB', () => {
  const args = [oversizedKeyObject()];
  assert.ok(measure(args) > INPUT_BUDGET, 'worker budget must include property names');
  assert.ok(
    valueSize(args, new Set(), INPUT_BUDGET + 1) > INPUT_BUDGET,
    'host budget must independently include property names',
  );
});

test('worker and host reject custom Array property names that exceed 4 MiB', () => {
  const args = [oversizedKeyArray()];
  assert.ok(measure(args) > INPUT_BUDGET, 'worker budget must include Array custom property names');
  assert.ok(
    valueSize(args, new Set(), INPUT_BUDGET + 1) > INPUT_BUDGET,
    'host budget must independently include Array custom property names',
  );
});

test('property-name units accumulate across otherwise-small RPC objects', () => {
  const half = Math.floor(INPUT_BUDGET / 4) + 64;
  const first = [{ ['a'.repeat(half)]: null }];
  const second = [{ ['b'.repeat(half)]: null }];
  const workerTotal = measure(first) + measure(second);
  const hostTotal = valueSize(first, new Set(), INPUT_BUDGET + 1)
    + valueSize(second, new Set(), INPUT_BUDGET + 1);
  assert.ok(workerTotal > INPUT_BUDGET);
  assert.ok(hostTotal > INPUT_BUDGET);
});

test('normal objects stay below budget and worker/host key accounting agrees', () => {
  const args = [{ alpha: 1, beta: 'ok', nested: { gamma: true } }];
  const workerSize = measure(args);
  const hostSize = valueSize(args, new Set(), INPUT_BUDGET + 1);
  assert.equal(workerSize, hostSize);
  assert.ok(workerSize < INPUT_BUDGET);
});

test('sparse Arrays visit only enumerable own entries instead of iterating length', () => {
  const sparse = [];
  sparse.length = 2 ** 32 - 1;
  sparse[7] = 'x';
  Object.defineProperty(sparse, Symbol.iterator, {
    value() { throw new Error('RPC estimator must not invoke Array iteration'); },
  });

  assert.equal(measure(sparse), 18);
  assert.equal(valueSize(sparse, new Set(), INPUT_BUDGET + 1), 18);
});

test('arrays, strings, ArrayBuffer/views, and cyclic termination semantics are preserved', () => {
  assert.equal(measure([1, 'x', null]), 34);
  assert.equal(valueSize([1, 'x', null], new Set(), INPUT_BUDGET + 1), 34);

  const buffer = new ArrayBuffer(32);
  const view = new Uint8Array([1, 2, 3]);
  assert.equal(measure(buffer), 16, 'worker ArrayBuffer estimate remains unchanged');
  assert.equal(measure(view), 64, 'worker typed-array estimate remains unchanged');
  assert.equal(valueSize(buffer, new Set(), INPUT_BUDGET + 1), 32);
  assert.equal(valueSize(view, new Set(), INPUT_BUDGET + 1), 3);

  const cycle = {};
  cycle.self = cycle;
  assert.ok(Number.isFinite(measure(cycle)));
  assert.ok(Number.isFinite(valueSize(cycle, new Set(), INPUT_BUDGET + 1)));
});
