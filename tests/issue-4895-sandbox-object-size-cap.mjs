import assert from 'node:assert/strict';
import test from 'node:test';

import { createFunctionSandbox, MAX_SANDBOX_OBJECT_SIZE } from '../js/symbolic/function-sandbox.js';

test('#4895 default maxObjectSize stays 64 KiB and sub-minimum sizes use the documented floor', () => {
  assert.equal(MAX_SANDBOX_OBJECT_SIZE, 16 * 1024 * 1024);
  assert.equal(createFunctionSandbox({}, {}).maxObjectSize, 0x10000);
  assert.equal(createFunctionSandbox({}, { maxObjectSize: 16 }).maxObjectSize, 0x100);
});

test('#4895 sizes up to the 16 MiB contract are accepted unchanged', () => {
  assert.equal(createFunctionSandbox({}, { maxObjectSize: 0x200 }).maxObjectSize, 0x200);
  assert.equal(createFunctionSandbox({}, { maxObjectSize: MAX_SANDBOX_OBJECT_SIZE }).maxObjectSize, MAX_SANDBOX_OBJECT_SIZE);
});

test('#4895 oversized requests are bounded before setup mapping, never passed through', () => {
  for (const hostile of [
    MAX_SANDBOX_OBJECT_SIZE + 1,
    1024 * 1024 * 1024,
    Number.MAX_SAFE_INTEGER,
  ]) {
    const sandbox = createFunctionSandbox({}, { maxObjectSize: hostile });
    assert.ok(sandbox.maxObjectSize <= MAX_SANDBOX_OBJECT_SIZE, `maxObjectSize ${hostile} must not exceed the 16 MiB cap`);
  }
});

test('#4895 non-canonical sizes follow the uniform default policy', () => {
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 4096.5, '65536', {}, null]) {
    assert.equal(createFunctionSandbox({}, { maxObjectSize: invalid }).maxObjectSize, 0x10000);
  }
});

test('#4895 bounded object memory keeps working (initializer/modified-range snapshot unaffected)', async () => {
  const sandbox = createFunctionSandbox({}, { maxObjectSize: 0x1000 });
  await sandbox.setup(0x1000n, {
    objectAsArg0: false,
    objectMemory: [{ offset: 0x10, size: 4, value: 0xdeadbeefn }],
  });
  assert.equal(sandbox.beforeObjectBytes.get((sandbox.objectBase + 0x10n).toString()), 0xef);
  assert.equal(sandbox.beforeObjectBytes.get((sandbox.objectBase + 0x13n).toString()), 0xde);
});
