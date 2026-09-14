import assert from 'node:assert/strict';
import { createAppRuntimeIO, runtimeIdentityForApp } from '../../../js/runtime/app-runtime.js';

function makeApp({ architecture, capabilityArchitecture = architecture, fileArchitecture = null, sliceArchitecture = architecture } = {}) {
  const values = new Map();
  values.set('sliceIndex', 0);
  values.set('architecture', architecture ?? null);
  values.set('capability', capabilityArchitecture == null ? null : { architecture: capabilityArchitecture });
  values.set('regions', [{ id:'text', exec:true, vmAddr:0x1000n, size:0x1000n }]);
  values.set('fileInfo', {
    hash:'fixture-hash',
    ...(fileArchitecture == null ? {} : { architecture:fileArchitecture }),
    slices:[{
      capability: sliceArchitecture == null ? null : { architecture:sliceArchitecture },
      info:{ architecture:sliceArchitecture ?? null, uuid:'fixture-slice' },
    }],
  });
  let fetchCalls = 0;
  const app = {
    store:{ get:(key) => values.get(key) },
    backend:{
      contentHash:'fixture-hash',
      readAt:async()=>({found:false,bytes:null}),
      fetchChunk:async()=>{
        fetchCalls++;
        return { mn:['nop'], ops:[''] };
      },
    },
    symbols:null,
  };
  return { app, values, fetchCalls:() => fetchCalls };
}

{
  const { app, fetchCalls } = makeApp({ architecture:'arm64' });
  const row = await createAppRuntimeIO(app).fetch(0x1000n);
  assert.deepEqual(row, { mn:'nop', ops:'' });
  assert.equal(fetchCalls(), 1, 'ARM64 must retain the existing fixed-width local sandbox path');
}

{
  const { app, fetchCalls } = makeApp({ architecture:'arm64e' });
  const row = await createAppRuntimeIO(app).fetch(0x1000n);
  assert.deepEqual(row, { mn:'nop', ops:'' });
  assert.equal(fetchCalls(), 1, 'ARM64e must remain supported by the ARM64 local sandbox');
}

for (const architecture of ['x86_64', 'riscv64', null]) {
  const { app, fetchCalls } = makeApp({ architecture, capabilityArchitecture:architecture, sliceArchitecture:architecture });
  const row = await createAppRuntimeIO(app).fetch(0x1000n);
  assert.equal(row, null, `${architecture ?? 'unknown'} must fail closed instead of defaulting to ARM64`);
  assert.equal(fetchCalls(), 0, `${architecture ?? 'unknown'} must not invoke the fixed-width ARM64 worker`);
}

{
  const { app, fetchCalls } = makeApp({
    architecture:'x86_64',
    capabilityArchitecture:'x86_64',
    sliceArchitecture:'x86_64',
    fileArchitecture:'arm64',
  });
  const identity = await runtimeIdentityForApp(app);
  assert.match(identity.sliceIdentity, /:x86_64$/, 'runtime identity must use the selected-slice canonical architecture');
  assert.equal(await createAppRuntimeIO(app).fetch(0x1001n), null,
    'top-level file architecture must not override the active x86_64 slice');
  assert.equal(fetchCalls(), 0, 'mixed FAT metadata must not enter the ARM64 /4 fetch path');
}

{
  const { app, values, fetchCalls } = makeApp({ architecture:'arm64', sliceArchitecture:'arm64' });
  const io = createAppRuntimeIO(app);
  assert.deepEqual(await io.fetch(0x1000n), { mn:'nop', ops:'' });
  values.set('capability', { architecture:'x86_64' });
  values.set('architecture', 'x86_64');
  assert.equal(await io.fetch(0x1000n), null, 'slice changes must update the architecture decision without stale ARM64 fallback');
  assert.equal(fetchCalls(), 1, 'the stale local IO object must not issue a second ARM64 fetch after architecture change');
}

console.log('runtime active architecture: ok');
