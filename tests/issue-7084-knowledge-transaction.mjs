import assert from 'node:assert/strict';
import { KnowledgeDB } from '../js/knowledge/index.js';

// Request success and transaction completion are separate browser events.
function backend() {
  const durable = { functions: new Map(), negative: new Map() };
  let outcome = 'complete';
  let requestsDone;
  let finish;
  const db = {
    transaction() {
      const staged = [];
      const tx = { error: null, objectStore(name) {
        const request = (change) => {
          const req = {};
          queueMicrotask(() => {
            if (outcome === 'request-error') {
              req.error = new Error('request failed');
              req.onerror?.();
            } else {
              staged.push(change);
              req.onsuccess?.();
            }
          });
          return req;
        };
        return {
          put: (record) => request(() => durable[name].set(record.id, record)),
          clear: () => request(() => durable[name].clear()),
        };
      } };
      finish = () => {
        if (outcome === 'complete') {
          staged.forEach((change) => change());
          tx.oncomplete?.();
        } else {
          tx.error = new Error('transaction failed');
          if (outcome === 'error') tx.onerror?.();
          tx.onabort?.();
        }
      };
      setImmediate(() => requestsDone());
      return tx;
    },
  };
  const indexedDB = { open() {
    const req = {};
    queueMicrotask(() => { req.result = db; req.onsuccess?.(); });
    return req;
  } };
  return { durable, knowledge: new KnowledgeDB({ indexedDB }), async run(operation, nextOutcome) {
    outcome = nextOutcome;
    const ready = new Promise((resolve) => { requestsDone = resolve; });
    let settled = false;
    const result = operation().then((value) => { settled = true; return { value }; }, (error) => { settled = true; return { error }; });
    await ready;
    if (outcome !== 'request-error') assert.equal(settled, false, 'must wait for transaction completion');
    finish();
    return result;
  } };
}
const fingerprint = { address: 0x1000n, bytes: new Uint8Array([1, 2, 3, 4]), strings: [], imports: [] };
for (const operation of ['remember', 'reject', 'clear']) {
  const fixture = backend();
  const input = { id: 'confirmed', fingerprint, name: 'saved', candidateName: 'saved', confirmation: 'user-confirmed' };
  const invoke = () => fixture.knowledge[operation](input);
  for (const outcome of ['abort', 'error', 'request-error', 'complete']) {
    fixture.durable.functions.set('old', {});
    fixture.durable.negative.set('old', {});
    const result = await fixture.run(invoke, outcome);
    if (outcome !== 'complete') {
      assert.ok(result.error instanceof Error, `${operation} propagates ${outcome}`);
      assert.equal(fixture.durable.functions.has('old'), true);
      assert.equal(fixture.durable.negative.has('old'), true);
      assert.equal(fixture.durable.functions.has('confirmed'), false);
      assert.equal(fixture.durable.negative.has('confirmed'), false);
    } else if (operation === 'clear') {
      assert.equal(fixture.durable.functions.size, 0);
      assert.equal(fixture.durable.negative.size, 0);
    } else {
      assert.equal(result.error, undefined);
      assert.equal(fixture.durable[operation === 'remember' ? 'functions' : 'negative'].has(result.value.id), true);
    }
  }
}
const memory = new KnowledgeDB({ indexedDB: null });
await memory.remember({ id: 'saved', fingerprint });
await memory.reject({ id: 'rejected', candidateName: 'saved' });
assert.equal(memory.memory.size, 1);
assert.equal(memory.negativeMemory.size, 1);
await memory.clear();
assert.equal(memory.memory.size, 0);
assert.equal(memory.negativeMemory.size, 0);
console.log('issue-7084-knowledge-transaction: PASS');
