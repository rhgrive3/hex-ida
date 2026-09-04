import assert from 'node:assert/strict';
import { apiInfo } from '../../js/blocks.js';

/*
 * The generic table must describe complete API names. A locale-aware stdio
 * symbol is not the ABI of bare printf/fprintf, and malloc_* names are not
 * allocation calls merely because they share a prefix with malloc.
 */
for (const name of ['printf_l', '_printf_l', 'fprintf_l', '_fprintf_l']) {
  assert.notEqual(apiInfo(name)?.id, 'log', `${name} must not use bare log semantics`);
}

for (const name of [
  'malloc_zone_free', '_malloc_zone_free',
  'malloc_size', '_malloc_size',
  'malloc_good_size', '_malloc_good_size',
]) {
  const info = apiInfo(name);
  assert.notEqual(info?.id, 'malloc', `${name} must not be classified as malloc`);
  assert.notEqual(info?.effect, 'alloc', `${name} must not gain allocation effects`);
}

assert.deepEqual(apiInfo('printf'), {
  id: 'printf',
  re: apiInfo('printf').re,
  cat: 'log',
  args: ['format'],
  formatArg: 0,
  variadic: true,
  ret: 'status',
  effect: 'log',
});
assert.deepEqual(apiInfo('fprintf').args, ['stream', 'format']);
assert.equal(apiInfo('fprintf').formatArg, 1);

for (const name of ['malloc', '_malloc', 'calloc', 'valloc', '_Znwm', '_Znam', 'operator new', 'operator new[]']) {
  assert.equal(apiInfo(name)?.cat, 'memory', `${name} allocator contract regressed`);
  assert.equal(apiInfo(name)?.effect, 'alloc', `${name} allocator effect regressed`);
}

console.log('issue-6130-6121-api-boundaries: ok');
