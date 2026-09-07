import assert from 'node:assert/strict';

import { createAppRuntimeIO } from '../../../js/runtime/app-runtime.js';

function makeApp(architecture) {
  let fetchCalls = 0;
  const app = {
    store: {
      get(key) {
        if (key === 'regions') {
          return [{ id:'text', exec:true, vmAddr:0x1000n, size:0x100n }];
        }
        if (key === 'architecture') return architecture;
        return null;
      },
    },
    backend: {
      async readAt() {
        return { found:false, bytes:null };
      },
      async fetchChunk() {
        fetchCalls += 1;
        return { mn:['nop', 'ret'], ops:['', ''] };
      },
    },
    symbols:null,
  };
  return { app, fetchCalls:() => fetchCalls };
}

for (const architecture of ['arm64', 'arm64e', 'aarch64']) {
  const { app, fetchCalls } = makeApp(architecture);
  const io = createAppRuntimeIO(app);

  assert.deepEqual(await io.fetch(0x1000n), { mn:'nop', ops:'' });
  assert.deepEqual(await io.fetch(0x1004n), { mn:'ret', ops:'' });

  for (const address of [
    0x1001n, 0x1002n, 0x1003n,
    0x1005n, 0x1006n, 0x1007n,
  ]) {
    assert.equal(
      await io.fetch(address),
      null,
      `${architecture} must reject misaligned instruction address ${address.toString(16)}`,
    );
  }

  assert.equal(fetchCalls(), 2, `${architecture} must not fetch decoder chunks for rejected PCs`);
}

{
  const { app, fetchCalls } = makeApp('x86_64');
  const io = createAppRuntimeIO(app);
  assert.equal(await io.fetch(0x1000n), null);
  assert.equal(await io.fetch(0x1001n), null);
  assert.equal(fetchCalls(), 0, 'unsupported architectures must remain fail-closed before decode');
}

console.log('runtime app ARM64 alignment #4592: PASS');
