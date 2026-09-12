import assert from 'node:assert/strict';
import test from 'node:test';

import { EmulatorProvider } from '../../../js/runtime/emulator-provider.js';

let nonce = 0;

async function runFixture(result) {
  const provider = new EmulatorProvider({
    id: 'issue-4928-engine',
    version: '1',
    async execute() { return result; },
  }, { id: 'issue-4928-provider' });
  const session = await provider.openSession({
    binaryId: 'issue-4928-binary',
    sessionNonce: `issue-4928-${++nonce}`,
  }, { connect: false });
  try {
    return await session.facets.emulator.run({ fixture: nonce });
  } finally {
    await session.close();
  }
}

test('#4928 successful run preserves ordinary bounded completeness', async () => {
  const result = await runFixture({
    termination: 'return',
    events: [{ kind: 'basic-block', payload: { address: '0x1000' }, completeness: 'bounded' }],
  });

  assert.equal(result.completeness, 'bounded');
  assert.equal(result.batch.completeness, 'bounded');
  assert.equal(result.batch.events[0].completeness, 'bounded');
});

test('#4928 gap downgrades a successful run and batch to truncated', async () => {
  const result = await runFixture({
    termination: 'return',
    events: [{ kind: 'gap', payload: { reason: 'engine-trace-overflow' }, completeness: 'truncated' }],
  });

  assert.equal(result.completeness, 'truncated');
  assert.equal(result.batch.completeness, 'truncated');
  assert.equal(result.batch.events[0].completeness, 'truncated');
  assert.equal(result.evidence[0].completeness, 'truncated');
  assert.equal(result.recording.completeness, 'truncated');
});

test('#4928 dropped-events without explicit completeness is loss-bounded', async () => {
  const result = await runFixture({
    termination: 'return',
    events: [{ kind: 'dropped-events', payload: { count: 2 } }],
  });

  assert.equal(result.completeness, 'truncated');
  assert.equal(result.batch.completeness, 'truncated');
  assert.equal(result.batch.events[0].completeness, 'truncated');
});

test('#4928 explicit weaker source completeness is never upgraded by successful termination', async () => {
  const truncated = await runFixture({
    termination: 'return',
    events: [{ kind: 'trace-marker', payload: { marker: 1 }, completeness: 'truncated' }],
  });
  assert.equal(truncated.completeness, 'truncated');
  assert.equal(truncated.batch.completeness, 'truncated');
  assert.equal(truncated.batch.events[0].completeness, 'truncated');

  const unsupported = await runFixture({
    termination: 'return',
    events: [{ kind: 'trace-marker', payload: { marker: 2 }, completeness: 'unsupported' }],
  });
  assert.equal(unsupported.completeness, 'unsupported');
  assert.equal(unsupported.batch.completeness, 'unsupported');
  assert.equal(unsupported.batch.events[0].completeness, 'unsupported');
  assert.equal(unsupported.evidence[0].completeness, 'unsupported');
});

test('#4928 run-level truncation remains an upper bound for stronger source events', async () => {
  const result = await runFixture({
    termination: 'timeout',
    events: [{ kind: 'trace-marker', payload: { marker: 'late' }, completeness: 'complete' }],
  });

  assert.equal(result.completeness, 'truncated');
  assert.equal(result.batch.completeness, 'truncated');
  assert.equal(result.batch.events[0].completeness, 'truncated');
});

test('#4928 gap cannot self-upgrade to complete', async () => {
  const result = await runFixture({
    termination: 'return',
    events: [{ kind: 'gap', payload: { reason: 'loss' }, completeness: 'complete' }],
  });

  assert.equal(result.completeness, 'truncated');
  assert.equal(result.batch.completeness, 'truncated');
  assert.equal(result.batch.events[0].completeness, 'truncated');
});

test('#4928 malformed source completeness fails closed instead of being overwritten', async () => {
  await assert.rejects(
    () => runFixture({
      termination: 'return',
      events: [{ kind: 'trace-marker', payload: {}, completeness: ['complete'] }],
    }),
    (error) => error?.code === 'runtime-invalid-completeness',
  );
});

test('#4928 mixed ordinary and loss events conservatively reduce the whole run', async () => {
  const result = await runFixture({
    termination: 'return',
    events: [
      { kind: 'basic-block', payload: { address: '0x2000' }, completeness: 'bounded' },
      { kind: 'gap', payload: { reason: 'partial-trace' } },
    ],
  });

  assert.equal(result.completeness, 'truncated');
  assert.equal(result.batch.completeness, 'truncated');
  assert.deepEqual(result.batch.events.map((event) => event.completeness), ['bounded', 'truncated']);
  assert.deepEqual(result.evidence.map((node) => node.completeness), ['partial', 'truncated']);
});

test('#4928 loss marker preserves unsupported as the weaker source authority', async () => {
  const result = await runFixture({
    termination: 'return',
    events: [{ kind: 'dropped-events', payload: { count: 7 }, completeness: 'unsupported' }],
  });

  assert.equal(result.completeness, 'unsupported');
  assert.equal(result.batch.completeness, 'unsupported');
  assert.equal(result.batch.events[0].completeness, 'unsupported');
  assert.equal(result.evidence[0].completeness, 'unsupported');
});

test('#4928 malformed stateful completeness cannot pass validation on a later read', async () => {
  let reads = 0;
  const source = { kind: 'trace-marker', payload: {} };
  Object.defineProperty(source, 'completeness', {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? ['complete'] : 'complete';
    },
  });

  await assert.rejects(
    () => runFixture({ termination: 'return', events: [source] }),
    (error) => error?.code === 'runtime-invalid-completeness',
  );
  assert.equal(reads, 1);
});
