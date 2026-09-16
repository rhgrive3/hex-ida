import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import crypto from 'node:crypto';

const matrixUrl = new URL('./fixtures/x02-prior120-apple-version-matrix.json', import.meta.url);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const MATRIX_SHA256 = 'c95ea2ba89d072fe9110565072462d5efca496b72a66ff365d8b8d15a95274ad';
const currentOverrides = Object.freeze({
  'X02-A-07': 'pass',
  'X02-B-01': 'pass',
  'X02-B-02': 'pass',
  'X02-D-13': 'pass',
  'X02-E-11': 'pass',
  'X02-F-48': 'pass',
  'X02-G-03': 'pass',
});

const count = (rows, dispositionOf) => rows.reduce((acc, row) => {
  const disposition = dispositionOf(row);
  acc[disposition] = (acc[disposition] ?? 0) + 1;
  return acc;
}, {});

test('X-02 current overlay advances F-48 without mutating the frozen 120-row matrix', () => {
  const matrixBytes = fs.readFileSync(matrixUrl);
  assert.equal(sha256(matrixBytes), MATRIX_SHA256, 'frozen X-02 denominator must remain unchanged');
  const matrix = JSON.parse(matrixBytes);
  assert.equal(matrix.rowCount, 120);
  assert.equal(matrix.rows.length, 120);

  assert.deepEqual(count(matrix.rows, row => row.expectedDisposition), {
    pass: 108,
    'product-gap': 6,
    'evidence-gap': 4,
    'environment-excluded': 2,
  });

  assert.deepEqual(matrix.rows.filter(row => Object.hasOwn(currentOverrides, row.id))
    .map(row => [row.id, row.check, row.expectedDisposition]), [
      ['X02-A-07', 'build-tool-gap', 'product-gap'],
      ['X02-B-01', 'cache-sync', 'product-gap'],
      ['X02-B-02', 'cache-async', 'product-gap'],
      ['X02-D-13', 'swift-version-gap', 'product-gap'],
      ['X02-E-11', 'objc-classless-gap', 'product-gap'],
      ['X02-F-48', 'evidence-missing', 'evidence-gap'],
      ['X02-G-03', 'signature-gap', 'product-gap'],
    ]);

  assert.deepEqual(count(matrix.rows, row => currentOverrides[row.id] ?? row.expectedDisposition), {
    pass: 115,
    'evidence-gap': 3,
    'environment-excluded': 2,
  });
});
