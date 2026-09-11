import assert from 'node:assert/strict';
import { parseMetadataFileInWorker } from '../js/il2cpp-runtime.js';

function workerFor(result = { parsed: true }) {
  return {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postCount: 0,
    terminated: 0,
    postMessage({ id }) {
      this.postCount += 1;
      queueMicrotask(() => this.onmessage?.({ data: { id, ok: true, result } }));
    },
    terminate() {
      this.terminated += 1;
    },
  };
}

{
  const worker = workerFor();
  const signal = {
    aborted: false,
    addEventListener(type) {
      assert.equal(type, 'abort');
      this.aborted = true;
    },
    removeEventListener() {},
  };
  const pending = parseMetadataFileInWorker({}, { signal, workerFactory: () => worker });
  await assert.rejects(pending, (error) => error?.name === 'AbortError' && error?.code === 'ABORT_ERR');
  assert.equal(worker.postCount, 0, 'registration-race cancellation must not start the worker parse');
  assert.equal(worker.terminated, 1, 'registration-race cancellation must terminate the worker');
}

{
  const controller = new AbortController();
  controller.abort('already-cancelled');
  let factoryCalls = 0;
  await assert.rejects(
    () => parseMetadataFileInWorker({}, { signal: controller.signal, workerFactory: () => { factoryCalls += 1; return workerFor(); } }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(factoryCalls, 0, 'already-aborted signals must reject before worker creation');
}

{
  const worker = workerFor({ version: 29 });
  const result = await parseMetadataFileInWorker({}, { workerFactory: () => worker });
  assert.deepEqual(result, { version: 29 });
  assert.equal(worker.postCount, 1);
  assert.equal(worker.terminated, 1, 'successful parsing must retain worker cleanup');
}

{
  const controller = new AbortController();
  const worker = workerFor();
  const pending = parseMetadataFileInWorker({}, { signal: controller.signal, workerFactory: () => worker });
  controller.abort('cancelled-during-parse');
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.equal(worker.terminated, 1, 'event-driven cancellation must retain worker cleanup');
}

console.log('issue-4500 IL2CPP abort registration race: PASS');
