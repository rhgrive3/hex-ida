import assert from 'node:assert/strict';
import test from 'node:test';
import { pageRows } from '../../../js/agent/tools.js';

for (const meta of [{}, { total: 3 }, { completeness: { complete: true } }]) {
  test(`local slice cannot inherit full upstream coverage ${JSON.stringify(meta)}`, () => {
    const result = pageRows({ results: ['a', 'b', 'c'], complete: true, coverage: 1, ...meta }, 2);
    assert.deepEqual(result.results, ['a', 'b']);
    assert.equal(result.total, 3);
    assert.equal(result.complete, false);
    assert.equal(result.truncated, true);
    assert.equal(result.coverage, 2 / 3);
    assert.equal(result.reason, 'result-limit');
  });
}

test('an offset-bearing upstream suffix retains its global total', () => {
  const result = pageRows({ results: ['a', 'b', 'c'], offset: 10, complete: true }, 2, 10);
  assert.equal(result.total, 13);
  assert.equal(result.complete, false);
  assert.equal(result.coverage, 12 / 13);
});

test('an explicit remaining total bounds a short page despite complete=true', () => {
  const result = pageRows({ results: ['a'], total: 3, complete: true }, 2);
  assert.equal(result.complete, false);
  assert.equal(result.total, 3);
});

test('final page, empty page and already-paged data keep their semantics', () => {
  const full = { results: ['a', 'b', 'c'], complete: true };
  assert.deepEqual(pageRows(full, 2, 2).results, ['c']);
  assert.equal(pageRows(full, 2, 2).complete, true);
  assert.equal(pageRows(full, 2, 100).total, 3);
  const paged = pageRows({ results: ['c'], offset: 2, total: 3, complete: true }, 2, 2);
  assert.equal(paged.complete, true);
  assert.equal(paged.coverage, 1);
  assert.deepEqual(paged.results, ['c']);
});

test('upstream incompleteness remains weaker than local exhaustion', () => {
  assert.equal(pageRows({ results: [1], complete: false, reason: 'scan-budget' }, 2).complete, false);
  assert.equal(pageRows({ results: [1], complete: false, reason: 'scan-budget' }, 2).reason, 'scan-budget');
});
