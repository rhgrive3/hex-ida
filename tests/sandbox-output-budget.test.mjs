import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The Worker output meter only runs inside the sandboxed Worker, so the
// regression extracts the shipped `outputSize` implementation from the source
// and executes it in isolation. This guards the exact code browsers run.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET = 256 * 1024;

function loadOutputSize() {
  const src = fs.readFileSync(path.join(ROOT, 'js/sandbox.js'), 'utf8');
  const match = src.match(/const OUTPUT_MAX_BYTES = 256 \* 1024;([\s\S]*?)\n  const outputLimit/);
  assert.ok(match, 'worker prelude must still define outputSize next to outputLimit');
  const factory = new Function(`const OUTPUT_MAX_BYTES = 256 * 1024;${match[1]}; return { outputSize };`);
  return factory().outputSize;
}

const outputSize = loadOutputSize();

test('keys past the scan cap still count against the output budget', () => {
  const payload = {};
  for (let i = 0; i < 2048; i++) payload[`s${i}`] = null;
  for (let i = 0; i < 1000; i++) payload[`long_${i}_${'x'.repeat(1000)}`] = null;
  assert.ok(
    outputSize({ t: 'print', args: [payload] }) > BUDGET,
    'unscanned tail keys must fail closed instead of looking small',
  );
});

test('large values past the scan cap cannot hide behind short leading keys', () => {
  const payload = {};
  for (let i = 0; i < 2048; i++) payload[`k${i}`] = 0;
  payload.tail = 'y'.repeat(2 * BUDGET);
  for (let i = 0; i < 10; i++) payload[`pad${i}`] = 0;
  const keys = Object.keys(payload);
  assert.ok(keys.length > 2048, 'fixture must spill past the scan cap');
  assert.ok(outputSize({ t: 'print', args: [payload] }) > BUDGET);
});

test('small payloads still pass the budget', () => {
  assert.ok(outputSize({ t: 'print', args: [{ hello: 'world' }] }) < BUDGET);
  const boundary = {};
  for (let i = 0; i < 2048; i++) boundary[`s${i}`] = null;
  assert.ok(outputSize({ t: 'print', args: [boundary] }) < BUDGET);
});
