import assert from 'node:assert/strict';
import {
  LLDBCompatibleAdapter,
  FridaCompatibleAdapter,
  ReplayAdapter,
} from '../../../js/adapters/index.js';
import { DebugAdapterError } from '../../../js/debug/adapter.js';

const transport = () => ({
  async send() {},
  onMessage() { return () => {}; },
});

for (const [make, expected] of [
  [() => new LLDBCompatibleAdapter(transport()), 'lldb-compatible'],
  [() => new LLDBCompatibleAdapter(transport(), { id:null }), 'lldb-compatible'],
  [() => new FridaCompatibleAdapter(transport()), 'frida-compatible'],
  [() => new FridaCompatibleAdapter(transport(), { id:undefined }), 'frida-compatible'],
  [() => new ReplayAdapter(), 'replay'],
  [() => new ReplayAdapter({}, { id:null }), 'replay'],
]) assert.equal(make().id, expected);

for (const [make, expected] of [
  [() => new LLDBCompatibleAdapter(transport(), { id:'lldb-custom' }), 'lldb-custom'],
  [() => new FridaCompatibleAdapter(transport(), { id:'frida-custom' }), 'frida-custom'],
  [() => new ReplayAdapter({}, { id:'replay-custom' }), 'replay-custom'],
]) assert.equal(make().id, expected);

for (const make of [
  ...['', '   ', false, 0].flatMap((id) => [
    () => new LLDBCompatibleAdapter(transport(), { id }),
    () => new FridaCompatibleAdapter(transport(), { id }),
    () => new ReplayAdapter({}, { id }),
  ]),
]) {
  assert.throws(
    make,
    (error) => error instanceof DebugAdapterError && error.code === 'invalid-adapter-id',
  );
}

console.log('debug adapter id boundary #3449: ok');
