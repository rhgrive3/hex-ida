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
  ['memcpy'],
  { toString: () => 'memcpy' },
  123,
  true,
  new String('memcpy'),
]) {
  assert.equal(apiInfo(name), null, 'structured API identities must not be coerced');
}

assert.equal(apiInfo('memcpy')?.id, 'memcpy', 'primitive API identity must remain recognized');

for (const name of [
  'malloc_zone_free', '_malloc_zone_free',
  'malloc_size', '_malloc_size',
  'malloc_good_size', '_malloc_good_size',
]) {
  const info = apiInfo(name);
  assert.notEqual(info?.id, 'malloc', `${name} must not be classified as malloc`);
  assert.notEqual(info?.effect, 'alloc', `${name} must not gain allocation effects`);
}

for (const name of ['malloc_size', '_malloc_size']) {
  const info = apiInfo(name);
  assert.equal(info?.id, 'libc_malloc_size', `${name} must use the Darwin allocation-size query contract`);
  assert.equal(info?.effect, 'read');
  assert.equal(info?.ret, 'length');
}

for (const name of ['os_log_create', '_os_log_create']) {
  const info = apiInfo(name);
  assert.equal(info?.id, 'os_log_create');
  assert.equal(info?.cat, 'log');
  assert.equal(info?.ret, 'handle');
  assert.equal(info?.effect, 'runtime');
}
for (const name of ['os_log_type_enabled', '_os_log_type_enabled']) {
  const info = apiInfo(name);
  assert.equal(info?.id, 'os_log_type_enabled');
  assert.equal(info?.cat, 'log');
  assert.equal(info?.ret, 'status');
  assert.equal(info?.effect, 'read');
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

for (const name of ['malloc_size', '_malloc_size']) {
  const info = apiInfo(name);
  assert.equal(info?.id, 'libc_malloc_size', `${name} must use the allocator-introspection contract`);
  assert.deepEqual(info?.args, ['ptr']);
  assert.equal(info?.ret, 'length');
  assert.equal(info?.effect, 'read');
}

for (const name of ['os_log_create', '_os_log_create']) {
  const info = apiInfo(name);
  assert.equal(info?.id, 'os_log_create', `${name} must use the logging-handle contract`);
  assert.deepEqual(info?.args, ['subsystem', 'category']);
  assert.equal(info?.ret, 'handle');
  assert.equal(info?.effect, 'runtime');
}

for (const name of ['os_log_type_enabled', '_os_log_type_enabled']) {
  const info = apiInfo(name);
  assert.equal(info?.id, 'os_log_type_enabled', `${name} must use the log-enabled query contract`);
  assert.deepEqual(info?.args, ['log', 'type']);
  assert.equal(info?.ret, 'status');
  assert.equal(info?.effect, 'read');
}

for (const name of [
  'malloc', '_malloc', 'calloc', 'valloc',
  '_Znwm', '_Znam',
  '_ZnwmSt11align_val_t', '_ZnamSt11align_val_t',
  '_ZnwmSt11align_val_tRKSt9nothrow_t',
  'operator new', 'operator new[]',
]) {
  assert.equal(apiInfo(name)?.cat, 'memory', `${name} allocator contract regressed`);
  assert.equal(apiInfo(name)?.effect, 'alloc', `${name} allocator effect regressed`);
}

console.log('issue-6130-6121-api-boundaries: ok');
