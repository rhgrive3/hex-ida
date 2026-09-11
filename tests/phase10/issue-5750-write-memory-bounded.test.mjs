import assert from 'node:assert/strict';

import { LocalFunctionSandboxAdapter, RemoteDebugAdapter } from '../../js/adapters/index.js';

let produced = 0;

function* finiteBytes(count, invalidAt = -1) {
  for (let index = 0; index < count; index += 1) {
    produced += 1;
    yield index === invalidAt ? 256 : 0;
  }
}

function* infiniteBytes() {
  while (true) {
    produced += 1;
    yield 0;
  }
}

function localHarness() {
  return Object.assign(Object.create(LocalFunctionSandboxAdapter.prototype), {
    capabilities: { writeMemory: true },
    require(name) {
      if (!this.capabilities[name]) throw new Error('capability-unavailable:' + name);
    },
    sandbox: { emulator: { async store() {} } },
    memoryMap: { assert() {} },
    traceState: { suppressMemory: 0 },
    epoch: 0,
  });
}

function remoteHarness() {
  return Object.assign(Object.create(RemoteDebugAdapter.prototype), {
    capabilities: { writeMemory: true },
    require(name) {
      if (!this.capabilities[name]) throw new Error('capability-unavailable:' + name);
    },
    requireMethod() {},
    call(_method, params) {
      return Promise.resolve({ written: params.bytes.length });
    },
  });
}

const adapters = [
  ['local', LocalFunctionSandboxAdapter, localHarness, 256 * 1024],
  ['remote', RemoteDebugAdapter, remoteHarness, 64 * 1024],
];

for (const [label, Adapter, makeHarness, limit] of adapters) {
  produced = 0;
  const inRange = await Adapter.prototype.writeMemory.call(makeHarness(), 0x1000n, finiteBytes(limit));
  assert.equal(inRange.written, limit, label + ' at-limit write result');
  assert.equal(produced, limit, label + ' at-limit enumeration');

  produced = 0;
  await assert.rejects(
    Adapter.prototype.writeMemory.call(makeHarness(), 0x1000n, finiteBytes(limit + 1)),
    (error) => error?.code === 'too-large',
    label + ' limit+1 write must fail closed',
  );
  assert.equal(produced, limit + 1, label + ' limit+1 enumeration');

  produced = 0;
  await assert.rejects(
    Adapter.prototype.writeMemory.call(makeHarness(), 0x1000n, infiniteBytes()),
    (error) => error?.code === 'too-large',
    label + ' infinite write must fail closed',
  );
  assert.equal(produced, limit + 1, label + ' infinite enumeration');

  produced = 0;
  await assert.rejects(
    Adapter.prototype.writeMemory.call(makeHarness(), 0x1000n, finiteBytes(4, 3)),
    (error) => error?.code === 'invalid-byte',
    label + ' invalid byte must fail closed',
  );
  assert.equal(produced, 4, label + ' invalid-byte enumeration');
}

console.log('issue-5750 bounded iterable write regression: ok');
