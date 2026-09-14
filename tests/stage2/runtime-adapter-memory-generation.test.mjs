import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../../js/adapters/index.js';

const externalAddress = 0x500000n;
const externalMapping = [{ start:externalAddress, size:0x1000, kind:'mapped', permissions:'rw' }];
const objectBase = 0x0000600000001000n;

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function blockingReadIo({ withExecution = false } = {}) {
  const started = deferred();
  const release = deferred();
  let readCount = 0;
  let fetchCount = 0;
  return {
    started,
    release,
    io:{
      read: async () => {
        readCount++;
        started.resolve();
        await release.promise;
        return new Uint8Array(0x1000);
      },
      fetch: withExecution ? async () => {
        fetchCount++;
        return fetchCount === 1 ? { mn:'ldr', ops:'x0, [x1]' } : { mn:'ret', ops:'' };
      } : undefined,
      isExecutable: withExecution ? () => true : undefined,
      symbolFor: withExecution ? () => null : undefined,
    },
  };
}

{
  const blocked = blockingReadIo();
  const adapter = new LocalFunctionSandboxAdapter(blocked.io);
  await adapter.connect();
  await adapter.launch({ address:0x1000n, objectAsArg0:false, memoryMappings:externalMapping });

  const oldRead = adapter.readMemory(externalAddress, 1);
  await blocked.started.promise;
  await adapter.launch({ address:0x2000n, objectAsArg0:false });
  blocked.release.resolve();

  await assert.rejects(
    oldRead,
    (error) => error?.code === 'stale-request',
    'a read that completes after a newer launch must not return old-generation bytes',
  );
  assert.equal((await adapter.readRegisters()).pc, 0x2000n);
  await adapter.disconnect();
}

{
  const blocked = blockingReadIo({ withExecution:true });
  const adapter = new LocalFunctionSandboxAdapter(blocked.io);
  await adapter.connect();
  await adapter.launch({ address:0x1000n, objectAsArg0:false, memoryMappings:externalMapping });

  const oldWrite = adapter.writeMemory(externalAddress, new Uint8Array([0x7f]));
  await blocked.started.promise;

  await adapter.launch({
    address:0x2000n,
    objectAsArg0:false,
    registers:{ x1:objectBase },
    objectMemory:[{ offset:0, size:8, value:0x1234n }],
    traceMemoryReads:true,
  });
  await adapter.resume({ maxSteps:10 });
  assert.ok(
    (await adapter.trace()).events.some((event) => event.type === 'memory-read'),
    'an obsolete explicit write must not suppress memory evidence from the new generation',
  );

  blocked.release.resolve();
  await assert.rejects(
    oldWrite,
    (error) => error?.code === 'stale-request',
    'a write that completes after a newer launch must not report current-generation success',
  );
  assert.equal((await adapter.readRegisters()).pc, 0n);
  await adapter.disconnect();
}
