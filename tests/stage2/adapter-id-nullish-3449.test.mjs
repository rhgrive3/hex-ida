import assert from 'node:assert/strict';

import {
  LLDBCompatibleAdapter,
  FridaCompatibleAdapter,
  ReplayAdapter,
} from '../../js/adapters/index.js';
import { DebugAdapterError } from '../../js/debug/adapter.js';

const transport = () => ({
  async send() {},
  onMessage() { return () => {}; },
});

// Nullish/omitted ids retain the adapter defaults.
{
  assert.equal(new LLDBCompatibleAdapter(transport()).id, 'lldb-compatible');
  assert.equal(new LLDBCompatibleAdapter(transport(), { id: null }).id, 'lldb-compatible');
  assert.equal(new FridaCompatibleAdapter(transport()).id, 'frida-compatible');
  assert.equal(new FridaCompatibleAdapter(transport(), { id: undefined }).id, 'frida-compatible');
  assert.equal(new ReplayAdapter().id, 'replay');
  assert.equal(new ReplayAdapter({}, { id: null }).id, 'replay');
}

// Explicit valid ids remain untouched.
{
  assert.equal(new LLDBCompatibleAdapter(transport(), { id: 'lldb-custom' }).id, 'lldb-custom');
  assert.equal(new FridaCompatibleAdapter(transport(), { id: 'frida-custom' }).id, 'frida-custom');
  assert.equal(new ReplayAdapter({}, { id: 'replay-custom' }).id, 'replay-custom');
}

// #3449: explicit invalid empty ids must reach DebugAdapter validation instead
// of being rewritten into a valid fallback by `||`.
for (const make of [
  () => new LLDBCompatibleAdapter(transport(), { id: '' }),
  () => new LLDBCompatibleAdapter(transport(), { id: '   ' }),
  () => new FridaCompatibleAdapter(transport(), { id: '' }),
  () => new FridaCompatibleAdapter(transport(), { id: '   ' }),
  () => new ReplayAdapter({}, { id: '' }),
  () => new ReplayAdapter({}, { id: '   ' }),
]) {
  assert.throws(
    make,
    (error) => error instanceof DebugAdapterError && error.code === 'invalid-adapter-id',
  );
}

console.log('adapter id nullish-default regression #3449: PASS');
