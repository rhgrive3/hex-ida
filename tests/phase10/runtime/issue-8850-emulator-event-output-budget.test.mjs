import assert from 'node:assert/strict';
import test from 'node:test';

import { EmulatorProvider } from '../../../js/runtime/emulator-provider.js';

const binaryId = 'bin_sha256_' + '5d'.repeat(32);

function engineReturning(result) {
  return {
    id: 'repro',
    version: '1',
    async execute() { return typeof result === 'function' ? result() : result; },
  };
}

async function runOnce(result, runOptions = {}) {
  const provider = new EmulatorProvider(engineReturning(result));
  const session = await provider.openSession({ binaryId, sessionNonce: 'issue-8850' }, { connect: false });
  return session.facets.emulator.run({}, { timeoutMs: 2000, ...runOptions });
}

test('#8850 a deeply nested engine event yields a bounded truncated result, never a native stack overflow', async () => {
  let payload = { leaf: true };
  for (let i = 0; i < 50000; i += 1) payload = { next: payload };
  const before = process.memoryUsage().heapUsed;
  const result = await runOnce({ termination: 'return', events: [{ kind: 'emulator-checkpoint', streamId: 's', sequence: 1, payload }] });

  assert.equal(result.completeness, 'truncated', 'exceeding the engine-event authority demotes completeness');
  assert.ok(result.batch.dropped >= 1, 'the oversized event is reported as dropped');
  const kinds = result.batch.events.map((event) => event.kind);
  assert.ok(kinds.includes('dropped-events'), 'a dropped-events marker records the truncation');
  assert.ok(process.memoryUsage().heapUsed - before < 128 * 1024 * 1024, 'post-engine work stays bounded well below the heap limit');
});

test('#8850 engine event count above the cap is truncated before the complete collection is mapped', async () => {
  const events = Array.from({ length: 100 }, (_, i) => ({ kind: 'emulator-checkpoint', streamId: `s${i}`, sequence: i, payload: { i } }));
  const result = await runOnce({ termination: 'return', events }, { events: { maxEvents: 10 } });

  const checkpointCount = result.batch.events.filter((event) => event.kind === 'emulator-checkpoint').length;
  assert.equal(checkpointCount, 10, 'only the configured number of engine events is mapped');
  assert.equal(result.batch.dropped, 90, 'the un-mapped remainder is reported as dropped');
  assert.equal(result.completeness, 'truncated');
});

test('#8850 a huge non-event raw field cannot bypass the output budget through recording.raw', async () => {
  const blob = 'x'.repeat(20 * 1024 * 1024);
  const result = await runOnce({ termination: 'return', blob });
  assert.equal(result.raw.truncated, true, 'the retained raw snapshot is truncated at the output budget');
  assert.equal(result.recording.raw.truncated, true);
  assert.notEqual(typeof result.raw, 'string');
  assert.equal(result.completeness, 'truncated');
});

test('#8850 exactly-at-limit event batches are admitted without spurious truncation and keep deterministic identities', async () => {
  const makeEvents = () => Array.from({ length: 5 }, (_, i) => ({ kind: 'emulator-checkpoint', streamId: 'stable', sequence: i, payload: { i } }));
  const provider = new EmulatorProvider({ id: 'repro', version: '1', async execute() { return { termination: 'return', events: makeEvents() }; } });
  const session = await provider.openSession({ binaryId, sessionNonce: 'issue-8850-limit' }, { connect: false });
  const first = await session.facets.emulator.run({}, { timeoutMs: 2000, events: { maxEvents: 5 } });
  const second = await session.facets.emulator.run({}, { timeoutMs: 2000, events: { maxEvents: 5 } });

  assert.equal(first.batch.dropped, 0, 'a batch exactly at the ceiling must not report drops');
  assert.notEqual(first.completeness, 'truncated', 'an exactly-at-limit batch is not truncated');
  assert.equal(first.batch.events.length, 5);
  assert.deepEqual(
    first.batch.events.map((event) => event.eventId),
    second.batch.events.map((event) => event.eventId),
    'exactly-at-limit identities are deterministic across runs',
  );
  assert.equal(new Set(first.batch.events.map((event) => event.eventId)).size, 5, 'event identities are unique');
});

test('#8850 a normal small engine result stays bounded with unchanged evidence output', async () => {
  const result = await runOnce({ termination: 'return', events: [{ kind: 'emulator-checkpoint', streamId: 's', sequence: 1, payload: { pc: 1000 } }] });
  assert.equal(result.completeness, 'bounded');
  assert.equal(result.batch.dropped, 0);
  assert.equal(result.batch.events.length, 1);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.recording.raw.truncated, undefined, 'normal raw is retained verbatim');
  assert.equal(result.recording.raw.events[0].payload.pc, 1000);
});
