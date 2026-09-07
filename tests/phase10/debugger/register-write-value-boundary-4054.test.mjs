import assert from 'node:assert/strict';
import {
  LocalFunctionSandboxAdapter,
  RemoteDebugAdapter,
} from '../../../js/adapters/index.js';
import { DebugAdapterError } from '../../../js/debug/adapter.js';

function transport() {
  return {
    async send() {},
    onMessage() { return () => {}; },
  };
}

function localHarness() {
  const adapter = new LocalFunctionSandboxAdapter({});
  const registers = new Map();
  const sandbox = {
    emulator: { pc: 0n },
    setRegister(name, value) { registers.set(name, value); },
    getRegister(name) { return registers.get(name); },
  };
  adapter.ensureSandbox = () => sandbox;
  return { adapter, registers, sandbox };
}

{
  const { adapter, registers, sandbox } = localHarness();
  assert.equal((await adapter.writeRegister('x0', 1n)).value, 1n);
  assert.equal((await adapter.writeRegister('x1', 2)).value, 2n);
  assert.equal((await adapter.writeRegister('x2', '3')).value, 3n);
  assert.equal((await adapter.writeRegister('x3', '0x4')).value, 4n);
  assert.equal((await adapter.writeRegister('w0', '4294967295')).value, 0xffffffffn);
  assert.equal((await adapter.writeRegister('pc', '0x20')).value, 0x20n);
  assert.equal(registers.get('x0'), 1n);
  assert.equal(sandbox.emulator.pc, 0x20n);
}

const invalidValues = [
  true,
  false,
  [],
  ['1'],
  {},
  '',
  '   ',
  '-1',
  -1,
  -1n,
  1.5,
  Number.MAX_SAFE_INTEGER + 1,
];

for (const value of invalidValues) {
  const { adapter } = localHarness();
  await assert.rejects(
    adapter.writeRegister('x0', value),
    (error) => error instanceof DebugAdapterError && error.code === 'invalid-register-value',
  );
}

for (const [reg, value] of [
  ['w0', 0x100000000n],
  ['x0', 0x10000000000000000n],
]) {
  const { adapter } = localHarness();
  await assert.rejects(
    adapter.writeRegister(reg, value),
    (error) => error instanceof DebugAdapterError && error.code === 'invalid-register-value',
  );
}

{
  const adapter = new RemoteDebugAdapter(transport(), { capabilities: { writeRegister:true } });
  const calls = [];
  adapter.call = (method, params) => {
    calls.push({ method, params });
    return Promise.resolve({ method, params });
  };

  await adapter.writeRegister('x0', '0x10', 'thread:7');
  assert.deepEqual(calls, [{
    method:'writeRegister',
    params:{ reg:'x0', value:'16', threadId:'thread:7' },
  }]);

  let coerced = 0;
  const objectValue = { toString() { coerced++; return '123'; } };
  assert.throws(
    () => adapter.writeRegister('x0', objectValue, 'thread:7'),
    (error) => error instanceof DebugAdapterError && error.code === 'invalid-register-value',
  );
  assert.equal(coerced, 0);
  assert.equal(calls.length, 1, 'invalid values must not reach the remote mutation call');

  for (const value of [true, ['1'], '', ' ', -1n, 1.25, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => adapter.writeRegister('x0', value),
      (error) => error instanceof DebugAdapterError && error.code === 'invalid-register-value',
    );
  }
  assert.throws(
    () => adapter.writeRegister('w0', 0x100000000n),
    (error) => error instanceof DebugAdapterError && error.code === 'invalid-register-value',
  );
  assert.equal(calls.length, 1);
}

console.log('debug register write value boundary #4054: ok');
