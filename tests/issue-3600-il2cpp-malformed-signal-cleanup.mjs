import assert from 'node:assert/strict';
import { parseMetadataFileInWorker } from '../js/il2cpp-runtime.js';

function fakeWorker() {
  return {
    terminated: 0,
    postCount: 0,
    terminate() { this.terminated += 1; },
    postMessage() { this.postCount += 1; },
  };
}

for (const signal of [
  { aborted:false },
  { aborted:false, addEventListener() {} },
  { aborted:false, removeEventListener() {} },
  true,
  'signal',
]) {
  let factoryCalls = 0;
  const worker = fakeWorker();
  await assert.rejects(
    () => parseMetadataFileInWorker({}, {
      signal,
      workerFactory: () => { factoryCalls += 1; return worker; },
    }),
    TypeError,
  );
  assert.equal(factoryCalls, 0, 'malformed signal must fail before worker creation');
  assert.equal(worker.postCount, 0);
  assert.equal(worker.terminated, 0, 'no worker exists to leak when validation fails');
}

console.log('issue-3600 IL2CPP malformed signal cleanup: PASS');
