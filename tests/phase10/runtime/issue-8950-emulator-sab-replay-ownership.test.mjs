import assert from 'node:assert/strict';
import test from 'node:test';

import { EmulatorProvider } from '../../../js/runtime/emulator-provider.js';

// The engine result carries an explicit `events` array so the provider's
// raw-embedding fallback checkpoint (which canonicalizes `raw` through the
// JSON-safe identity and cannot represent shared memory or cycles) is skipped.
// `raw` is still snapshotted by the recording via `ownedClone`, which is the
// exact boundary this issue repairs.
const BENIGN_EVENTS = [{ kind: 'return', payload: { ok: 1 } }];

async function openSession(engine, sessionNonce = 'sab-8950') {
  const provider = new EmulatorProvider(engine, { id: `emulator-8950-${engine.id}` });
  return provider.openSession({ binaryId: 'binary-8950', sessionNonce }, { connect: false });
}

test('#8950 A: a frozen recording stays independent from later producer SAB mutation and replays original bytes', async () => {
  const seen = [];
  const rawSab = new SharedArrayBuffer(1);
  new Uint8Array(rawSab)[0] = 3;
  const engine = {
    id: 'sab-recording-a',
    version: '1',
    deterministic: true,
    async execute(input, options) {
      const inputByte = new Uint8Array(input.buffer)[0];
      const optionByte = new Uint8Array(options.token)[0];
      seen.push({ inputByte, optionByte });
      return { termination: 'return', events: BENIGN_EVENTS, observed: { inputByte, optionByte }, retained: rawSab };
    },
  };
  const session = await openSession(engine);
  const inputSab = new SharedArrayBuffer(1);
  const optionSab = new SharedArrayBuffer(1);
  new Uint8Array(inputSab)[0] = 1;
  new Uint8Array(optionSab)[0] = 2;

  const first = await session.facets.emulator.run(
    { buffer: inputSab },
    { token: optionSab, maxSteps: 1, timeoutMs: 100 },
  );
  assert.deepEqual(seen[0], { inputByte: 1, optionByte: 2 });
  assert.equal(new Uint8Array(first.recording.input.buffer)[0], 1);
  assert.equal(new Uint8Array(first.recording.options.token)[0], 2);
  assert.equal(new Uint8Array(first.recording.raw.retained)[0], 3);
  assert.equal(first.recording.input.buffer instanceof SharedArrayBuffer, false, 'recording input is copied out of shared storage');

  // Mutating the original caller/engine-owned shared buffers must not touch the frozen recording.
  new Uint8Array(inputSab)[0] = 9;
  new Uint8Array(optionSab)[0] = 8;
  new Uint8Array(rawSab)[0] = 7;
  assert.equal(new Uint8Array(first.recording.input.buffer)[0], 1, 'recording input detached from caller SAB');
  assert.equal(new Uint8Array(first.recording.options.token)[0], 2, 'recording option detached from caller SAB');
  assert.equal(new Uint8Array(first.recording.raw.retained)[0], 3, 'recording raw detached from engine SAB');

  const before = JSON.stringify(first.recording.sourceIdentity);
  const replayed = await session.facets.emulator.replay(first.recording);
  assert.equal(JSON.stringify(first.recording.sourceIdentity), before, 'sourceIdentity stays stable across replay');
  assert.equal(replayed.raw.observed.inputByte, 1, 'replay executes the original admitted input, not the mutated caller buffer');
  assert.equal(replayed.raw.observed.optionByte, 2, 'replay executes the original admitted option, not the mutated caller buffer');
  await session.close();
});

test('#8950 B: replayRecordingClone fully detaches an external recording before engine execution (no TOCTOU)', async () => {
  let entered = 0;
  let engineEntered;
  const enteredGate = new Promise((resolve) => { engineEntered = resolve; });
  let releaseEngine;
  const releaseGate = new Promise((resolve) => { releaseEngine = resolve; });
  const engine = {
    id: 'sab-recording-b',
    version: '1',
    deterministic: true,
    async execute(input) {
      entered += 1;
      const byte = new Uint8Array(input.buffer)[0];
      if (entered === 2) {
        engineEntered();
        await releaseGate;
      }
      return { termination: 'return', events: BENIGN_EVENTS, observedByte: byte };
    },
  };
  const session = await openSession(engine);
  const externalSab = new SharedArrayBuffer(1);
  new Uint8Array(externalSab)[0] = 4;
  const admitted = await session.facets.emulator.run({ buffer: externalSab }, { maxSteps: 1, timeoutMs: 100 });
  assert.equal(admitted.raw.observedByte, 4);
  const externalRecording = admitted.recording;

  const pending = session.facets.emulator.replay(externalRecording, { timeoutMs: 5000 });
  await enteredGate;
  // Mutate the external recording AFTER replay admitted/cloned it but before the engine reads input.
  new Uint8Array(externalRecording.input.buffer)[0] = 9;
  releaseEngine();
  const replayed = await pending;
  assert.equal(replayed.raw.observedByte, 4, 'mutation after replay admission must not change the in-flight engine input');
  await session.close();
});

test('#8950 C: the published recording does not expose a reverse write channel into caller shared storage', async () => {
  const engine = {
    id: 'sab-recording-c',
    version: '1',
    deterministic: true,
    async execute(input) {
      return { termination: 'return', events: BENIGN_EVENTS, echoByte: new Uint8Array(input.buffer)[0] };
    },
  };
  const session = await openSession(engine);
  const callerSab = new SharedArrayBuffer(1);
  new Uint8Array(callerSab)[0] = 5;
  const result = await session.facets.emulator.run({ buffer: callerSab }, { maxSteps: 1, timeoutMs: 100 });
  new Uint8Array(result.recording.input.buffer)[0] = 6;
  assert.equal(new Uint8Array(callerSab)[0], 5, 'recording buffer must not alias the caller-owned shared block');
  await session.close();
});

test('#8950: a direct SharedArrayBuffer becomes a private copy while cycles/Map/Set identity survive', async () => {
  const engine = {
    id: 'sab-recording-struct',
    version: '1',
    deterministic: true,
    async execute() {
      const shared = new SharedArrayBuffer(2);
      new Uint8Array(shared).set([10, 20]);
      const node = { tag: 'root' };
      node.self = node;                 // cycle
      node.map = new Map([['bytes', new Uint8Array(shared)]]);
      node.set = new Set([shared]);     // direct SAB as a member
      return { termination: 'return', events: BENIGN_EVENTS, value: node };
    },
  };
  const session = await openSession(engine);
  const result = await session.facets.emulator.run({}, { maxSteps: 1, timeoutMs: 100 });
  const value = result.recording.raw.value;
  assert.equal(value.self, value, 'cycle preserved through recording clone');
  assert.equal(value.map.get('bytes')[0], 10);
  assert.equal(value.map.get('bytes')[1], 20);
  const [member] = [...value.set];
  assert.ok(!(member instanceof SharedArrayBuffer), 'shared block must not be exposed as a mutable recording capability');
  assert.equal(new Uint8Array(member)[0], 10);
  assert.equal(new Uint8Array(member)[1], 20);
  await session.close();
});

test('#8950: ordinary non-shared buffers keep exact private-copy semantics', async () => {
  const engine = {
    id: 'sab-recording-plain',
    version: '1',
    deterministic: true,
    async execute(input) {
      return { termination: 'return', events: BENIGN_EVENTS, firstByte: new Uint8Array(input.buffer)[0] };
    },
  };
  const session = await openSession(engine);
  const buffer = new ArrayBuffer(1);
  new Uint8Array(buffer)[0] = 42;
  const result = await session.facets.emulator.run({ buffer }, { maxSteps: 1, timeoutMs: 100 });
  assert.equal(result.recording.input.buffer instanceof SharedArrayBuffer, false);
  assert.notEqual(result.recording.input.buffer, buffer, 'recording owns an independent ArrayBuffer copy');
  new Uint8Array(buffer)[0] = 1;
  assert.equal(new Uint8Array(result.recording.input.buffer)[0], 42, 'mutating the original ArrayBuffer cannot change the recording');
  await session.close();
});
