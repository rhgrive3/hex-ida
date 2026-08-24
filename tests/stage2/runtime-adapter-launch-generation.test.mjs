import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../../js/adapters/index.js';

const watchedAddress = 0x500000n;
const deferredLaunchSpec = {
  address:0x1000n,
  objectAsArg0:false,
  watch:[{ address:watchedAddress, size:8 }],
  memoryMappings:[{ start:watchedAddress, size:0x1000, kind:'mapped', permissions:'rw' }],
};

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function blockingIo() {
  const started = deferred();
  const release = deferred();
  let reads = 0;
  return {
    started,
    release,
    io:{
      read: async () => {
        reads++;
        started.resolve();
        await release.promise;
        return new Uint8Array(0x1000);
      },
    },
    reads:() => reads,
  };
}

{
  const blocked = blockingIo();
  const adapter = new LocalFunctionSandboxAdapter(blocked.io);
  await adapter.connect();
  const launching = adapter.launch(deferredLaunchSpec);
  await blocked.started.promise;

  await adapter.disconnect();
  blocked.release.resolve();

  await assert.rejects(
    launching,
    (error) => error?.code === 'stale-launch',
    'a launch invalidated by disconnect must not publish after its backing read resumes',
  );
  assert.equal(adapter.connected, false);
  assert.equal(adapter.sandbox, null);
  assert.equal(adapter.memoryMap, null);
  assert.equal(adapter.epoch, 0);
}

{
  const blocked = blockingIo();
  const adapter = new LocalFunctionSandboxAdapter(blocked.io);
  await adapter.connect();
  const older = adapter.launch(deferredLaunchSpec);
  await blocked.started.promise;

  const newer = await adapter.launch({ address:0x2000n, objectAsArg0:false, registers:{x0:22n} });
  assert.equal(newer.epoch, 1);
  assert.equal((await adapter.readRegisters()).pc, 0x2000n);
  assert.equal((await adapter.readRegisters()).x0, 22n);

  blocked.release.resolve();
  await assert.rejects(
    older,
    (error) => error?.code === 'stale-launch',
    'an older deferred launch must not overwrite a newer published launch',
  );
  assert.equal(adapter.epoch, 1, 'obsolete launch must not advance the published epoch');
  assert.equal((await adapter.readRegisters()).pc, 0x2000n);
  assert.equal((await adapter.readRegisters()).x0, 22n);

  await adapter.disconnect();
}
