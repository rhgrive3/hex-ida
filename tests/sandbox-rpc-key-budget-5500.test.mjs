import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(ROOT, 'js/sandbox.js'), 'utf8');
const instrumented = `${source}\nexport { valueSize as __valueSizeForTest };`;
const mod = await import(`data:text/javascript;base64,${Buffer.from(instrumented).toString('base64')}`);

function loadWorkerMeasure() {
  const match = source.match(/  const measure = \(value, seen = new Set\(\), limit = MAX_ARGUMENT_UNITS \+ 1\) => \{([\s\S]*?)\n  \};\n\n  const rpc/);
  assert.ok(match, 'worker prelude must still define measure next to rpc');
  const factory = new Function(`
    const MAX_ARGUMENT_UNITS = 4 * 1024 * 1024;
    const measure = (value, seen = new Set(), limit = MAX_ARGUMENT_UNITS + 1) => {${match[1]}
    };
    return measure;
  `);
  return factory();
}

const workerMeasure = loadWorkerMeasure();
const BUDGET = 4 * 1024 * 1024;

function hugeKeyPayload() {
  const payload = {};
  for (let i = 0; i < 3000; i++) {
    payload[`k${i}_${'x'.repeat(800)}`] = null;
  }
  return payload;
}

test('worker RPC meter includes object property-name bytes', () => {
  const payload = hugeKeyPayload();
  assert.ok(workerMeasure([payload], new Set(), BUDGET + 1) > BUDGET);
});

test('host RPC meter independently includes object property-name bytes', () => {
  const payload = hugeKeyPayload();
  assert.ok(mod.__valueSizeForTest([payload], new Set(), BUDGET + 1) > BUDGET);
});

test('small object and cyclic/shared values keep bounded measurement semantics', () => {
  const small = { hello: null, nested: { value: 1 } };
  assert.ok(workerMeasure([small], new Set(), BUDGET + 1) < BUDGET);
  assert.ok(mod.__valueSizeForTest([small], new Set(), BUDGET + 1) < BUDGET);

  const cycle = { label: 'x' };
  cycle.self = cycle;
  assert.ok(workerMeasure([cycle], new Set(), BUDGET + 1) < BUDGET);
  assert.ok(mod.__valueSizeForTest([cycle], new Set(), BUDGET + 1) < BUDGET);
});
