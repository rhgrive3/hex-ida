import assert from 'node:assert/strict';

import { LocalFunctionSandboxAdapter } from '../js/adapters/index.js';

function harness() {
  const stored = [];
  const adapter = Object.assign(Object.create(LocalFunctionSandboxAdapter.prototype), {
    capabilities: { writeMemory: true },
    require(name) {
      if (!this.capabilities[name]) throw new Error('capability-unavailable:' + name);
    },
    sandbox: { emulator: { async store(address, size, value) { stored.push({ address, size, value }); } } },
    memoryMap: { assert() {} },
    traceState: { suppressMemory: 0 },
    epoch: 0,
  });
  return { adapter, stored };
}

{
  const { adapter, stored } = harness();
  const result = await adapter.writeMemory(0x1000n, new Uint8Array([0, 255]));
  assert.deepEqual(result, { written: 2 }, 'Uint8Array write must stay accepted');
  assert.equal(stored.length, 1, 'Uint8Array write must reach the emulator');
}

{
  const { adapter, stored } = harness();
  const result = await adapter.writeMemory(0x1000n, [0, 255]);
  assert.deepEqual(result, { written: 2 }, 'byte array write must stay accepted');
  assert.equal(stored.length, 1, 'byte array write must reach the emulator');
}

{
  const { adapter, stored } = harness();
  assert.deepEqual(await adapter.writeMemory(0x1000n, []), { written: 0 }, 'empty array stays a valid no-op');
  assert.deepEqual(await adapter.writeMemory(0x1000n, new Uint8Array()), { written: 0 }, 'empty Uint8Array stays a valid no-op');
  assert.equal(stored.length, 0, 'empty writes must not touch the emulator');
}

const malformedContainers = [
  ['plain object', {}],
  ['empty array-like', { length: 0 }],
  ['materializing array-like', { length: 2, 0: 1, 1: 1 }],
  ['boolean true', true],
  ['boolean false', false],
  ['number', 123],
  ['zero', 0],
  ['empty string', ''],
  ['string', 'abc'],
  ['null', null],
  ['undefined', undefined],
];

for (const [label, value] of malformedContainers) {
  const { adapter, stored } = harness();
  await assert.rejects(
    adapter.writeMemory(0x1000n, value),
    (error) => error?.code === 'invalid-byte',
    label + ' must be rejected instead of normalized to an empty write',
  );
  assert.equal(stored.length, 0, label + ' must not touch the emulator');
}

for (const malformed of [[256], [-1], [1.5], ['a'], [0, 256]]) {
  const { adapter } = harness();
  await assert.rejects(
    adapter.writeMemory(0x1000n, malformed),
    (error) => error?.code === 'invalid-byte',
    'malformed array element must keep the invalid-byte contract',
  );
}

console.log('issue-5003 writeMemory byte-container boundary regression: ok');
