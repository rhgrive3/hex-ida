import assert from 'node:assert/strict';
import { ArtifactStorageError, createArtifactDescriptor } from '../../../js/core/artifacts/contracts.js';
import { AnalysisScheduler } from '../../../js/core/scheduler/analysis-scheduler.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function waitState(scheduler, artifactId, state, turns = 1000) {
  for (let i = 0; i < turns; i++) {
    if (scheduler.state(artifactId) === state) return;
    await Promise.resolve();
  }
  assert.fail(`state ${state} not reached for ${artifactId}; got ${scheduler.state(artifactId)}`);
}

function descriptor(name) {
  return createArtifactDescriptor({
    binaryId:'bin_phase4_scheduler_5548',
    artifactKind:'phase4-scheduler-validator-fixture',
    producerId:'issue-5548-regression',
    producerVersion:'1',
    versions:{ loader:'fixture-1' },
    relevance:{ architectureSemantic:false, abiSemantic:false, semanticSchema:false },
    config:{ name },
  });
}

class ValidatingNoCacheStore {
  async get(descriptor, { signal } = {}) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    return { status:'miss', source:'memory', artifactId:descriptor.artifactId };
  }

  async publish(descriptor, payload, { signal, completeness='complete', validate=null } = {}) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    const record = { completeness };
    if (typeof validate === 'function') {
      const verdict = await validate(payload, record, { signal });
      if (verdict !== true) throw new ArtifactStorageError('artifact-validation-not-passed');
    }
    return { status:'published', artifactId:descriptor.artifactId, payload, record };
  }
}

// A later coalesced consumer owns its validator. It must not inherit the first
// request's publication decision simply because the producer is shared.
{
  const store = new ValidatingNoCacheStore();
  const scheduler = new AnalysisScheduler({ store, maxConcurrency:1 });
  const d = descriptor('reject-later-consumer');
  const gate = deferred();
  let producerCalls = 0;
  let validatorCalls = 0;

  const first = scheduler.request({
    descriptor:d,
    completeness:'complete',
    produce:async () => {
      producerCalls++;
      await gate.promise;
      return { route:'first' };
    },
  });
  await waitState(scheduler, d.artifactId, 'running');

  const second = scheduler.request({
    descriptor:d,
    completeness:'complete',
    validate:(payload) => {
      validatorCalls++;
      return payload.route === 'second';
    },
    produce:async () => {
      producerCalls++;
      return { route:'second' };
    },
  });

  gate.resolve();
  const firstResult = await first;
  assert.equal(firstResult.payload.route, 'first');
  await assert.rejects(
    second,
    (error) => error?.name === 'ArtifactStorageError' && error?.code === 'artifact-validation-not-passed',
  );
  assert.equal(producerCalls, 1, 'compatible requests must retain one shared producer');
  assert.equal(validatorCalls, 1, 'later consumer validator must run exactly once');
  assert.equal(scheduler.stats().coalescedRequests, 1);
}

// A positive later-consumer validator sees the shared canonical result and
// preserves the existing one-producer coalescing behavior.
{
  const store = new ValidatingNoCacheStore();
  const scheduler = new AnalysisScheduler({ store, maxConcurrency:1 });
  const d = descriptor('accept-later-consumer');
  const gate = deferred();
  let producerCalls = 0;
  let validatorCalls = 0;

  const first = scheduler.request({
    descriptor:d,
    completeness:'complete',
    produce:async () => {
      producerCalls++;
      await gate.promise;
      return { route:'shared' };
    },
  });
  await waitState(scheduler, d.artifactId, 'running');

  const second = scheduler.request({
    descriptor:d,
    completeness:'complete',
    validate:async (payload, record) => {
      validatorCalls++;
      return payload.route === 'shared' && record.completeness === 'complete';
    },
    produce:async () => {
      producerCalls++;
      return { route:'second' };
    },
  });

  gate.resolve();
  const [, secondResult] = await Promise.all([first, second]);
  assert.equal(secondResult.payload.route, 'shared');
  assert.equal(producerCalls, 1);
  assert.equal(validatorCalls, 1);
  assert.equal(scheduler.stats().coalescedRequests, 1);
}

// Validator exceptions are consumer-local: they reject that waiter without
// turning the already-published shared task into a failed job for other users.
{
  const store = new ValidatingNoCacheStore();
  const scheduler = new AnalysisScheduler({ store, maxConcurrency:1 });
  const d = descriptor('validator-throws');
  const gate = deferred();
  const boom = new Error('consumer-validator-boom');

  const first = scheduler.request({
    descriptor:d,
    produce:async () => {
      await gate.promise;
      return { ok:true };
    },
  });
  await waitState(scheduler, d.artifactId, 'running');

  const second = scheduler.request({
    descriptor:d,
    validate:async () => { throw boom; },
    produce:async () => ({ ok:false }),
  });

  gate.resolve();
  const firstResult = await first;
  assert.equal(firstResult.payload.ok, true);
  await assert.rejects(second, (error) => error === boom);
  assert.equal(scheduler.stats().failedJobs, 0, 'consumer validator failure must not rewrite producer job outcome');
}

// Consumer cancellation during its own async validation stays local and the
// validator receives a signal that reflects the cancelled waiter.
{
  const store = new ValidatingNoCacheStore();
  const scheduler = new AnalysisScheduler({ store, maxConcurrency:1 });
  const d = descriptor('validator-cancel');
  const producerGate = deferred();
  const validatorEntered = deferred();
  const validatorRelease = deferred();
  const controller = new AbortController();
  let validatorSignal = null;

  const first = scheduler.request({
    descriptor:d,
    produce:async () => {
      await producerGate.promise;
      return { ok:true };
    },
  });
  await waitState(scheduler, d.artifactId, 'running');

  const second = scheduler.request({
    descriptor:d,
    signal:controller.signal,
    validate:async (_payload, _record, { signal }) => {
      validatorSignal = signal;
      validatorEntered.resolve();
      await validatorRelease.promise;
      return true;
    },
    produce:async () => ({ ok:false }),
  });

  producerGate.resolve();
  await validatorEntered.promise;
  controller.abort(new DOMException('consumer stopped', 'AbortError'));
  validatorRelease.resolve();

  const firstResult = await first;
  assert.equal(firstResult.payload.ok, true);
  await assert.rejects(second, (error) => error?.name === 'AbortError');
  assert.equal(validatorSignal?.aborted, true, 'consumer validator signal must observe cancellation');
  assert.equal(scheduler.stats().failedJobs, 0);
}

console.log('issue #5548 scheduler coalesced validator: PASS');
