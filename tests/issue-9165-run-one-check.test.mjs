import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNpmRunArgs } from '../scripts/run-one-check.mjs';

test('#9165 buildNpmRunArgs forwards option-shaped arguments separated by --', () => {
  // Without extra args
  assert.deepEqual(buildNpmRunArgs('check'), ['run', '--', 'check']);
  assert.deepEqual(buildNpmRunArgs('check', []), ['run', '--', 'check']);

  // With option-shaped extra args
  assert.deepEqual(
    buildNpmRunArgs('test:unit', ['--grep', 'pattern']),
    ['run', '--', 'test:unit', '--', '--grep', 'pattern'],
  );

  // With positional extra args
  assert.deepEqual(
    buildNpmRunArgs('build', ['foo', 'bar']),
    ['run', '--', 'build', '--', 'foo', 'bar'],
  );

  // With boolean flags
  assert.deepEqual(
    buildNpmRunArgs('lint', ['--fix']),
    ['run', '--', 'lint', '--', '--fix'],
  );
});
