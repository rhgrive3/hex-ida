import test from 'node:test';
import assert from 'node:assert/strict';

import { extraApiInfo, EXTRA_API_FAMILY_COUNT } from '../js/api-cross-binary-families.js';

test('#1809 qsort/mergesort expose caller-buffer write effect', () => {
  for (const name of ['qsort', '_qsort', 'mergesort', '_mergesort']) {
    const info = extraApiInfo(name);
    assert.ok(info, `${name} should be classified`);
    assert.equal(info.id, 'libc_sort', name);
    assert.equal(info.effect, 'write', name);
    assert.equal(info.cat, 'memory', name);
  }
});

test('#1809 posix_memalign exposes output-pointer write effect', () => {
  const info = extraApiInfo('posix_memalign');
  assert.ok(info);
  assert.equal(info.id, 'libc_posix_memalign');
  assert.equal(info.effect, 'write');
});

test('#1809 difftime stays pure with a number return', () => {
  const info = extraApiInfo('difftime');
  assert.ok(info);
  assert.equal(info.id, 'libc_difftime');
  assert.equal(info.effect, 'pure');
  assert.equal(info.ret, 'number');
});

test('#1809 heterogeneous libc_runtime residue stays runtime without effect laundering', () => {
  for (const name of ['atexit', '_atexit', 'dlerror', 'close$NOCANCEL', 'perror']) {
    const info = extraApiInfo(name);
    assert.ok(info, `${name} should stay classified`);
    if (name === 'perror' || name === 'close$NOCANCEL') {
      assert.equal(info.id, 'libc_io_runtime', name);
      assert.equal(info.effect, 'io', name);
    } else {
      assert.equal(info.id, 'libc_runtime', name);
      assert.equal(info.effect, 'runtime', name);
    }
  }
});

test('#1809 reallocf exposes allocation semantics with heap return', () => {
  const info = extraApiInfo('reallocf');
  assert.ok(info);
  assert.equal(info.id, 'libc_reallocf');
  assert.equal(info.cat, 'memory');
  assert.equal(info.ret, 'heap');
  assert.equal(info.effect, 'alloc');
});


test('cross-binary Darwin query/log APIs retain non-laundered semantics', () => {
  for (const name of ['malloc_size', '_malloc_size']) {
    const info = extraApiInfo(name);
    assert.equal(info?.id, 'libc_malloc_size');
    assert.equal(info?.effect, 'read');
    assert.equal(info?.ret, 'length');
  }
  const create = extraApiInfo('_os_log_create');
  assert.equal(create?.id, 'os_log_create');
  assert.equal(create?.effect, 'runtime');
  assert.equal(create?.ret, 'handle');
  const enabled = extraApiInfo('_os_log_type_enabled');
  assert.equal(enabled?.id, 'os_log_type_enabled');
  assert.equal(enabled?.effect, 'read');
  assert.equal(enabled?.ret, 'status');
});

test('#1809 distinct effect families keep stable family identities', () => {
  assert.equal(EXTRA_API_FAMILY_COUNT, 41);
  assert.ok(extraApiInfo('_qsort') !== extraApiInfo('difftime'));
});
