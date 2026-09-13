import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter } from '../../../js/adapters/index.js';
import { DebugAdapterError } from '../../../js/debug/adapter.js';

function localHarness() {
  const registers = new Map([
    ['x0', 0x1111n], ['x1', 0x2222n], ['x30', 0x3333n],
    ['sp', 0x7000n], ['pc', 0x8000n],
  ]);
  const reads = [];
  const adapter = new LocalFunctionSandboxAdapter({});
  adapter.ensureSandbox = () => ({
    emulator: { pc: registers.get('pc') },
    getRegister(name) { reads.push(name); return registers.get(name); },
  });
  return { adapter, registers, reads };
}

function unsupported(expression) {
  return (error) => error instanceof DebugAdapterError && error.code === 'unsupported-expression';
}

for (const name of ['x0', 'x1', 'x30', 'sp', 'pc']) {
  const { adapter, registers, reads } = localHarness();
  assert.equal(await adapter.evaluate(name), registers.get(name), `${name} still evaluates`);
  assert.deepEqual(reads, [name]);
}

{
  const { adapter, reads } = localHarness();
  assert.equal(await adapter.evaluate('  x0  '), 0x1111n, 'a primitive string keeps its trim handling');
  assert.deepEqual(reads, ['x0']);
}

for (const expression of ['x31', 'lr', 'x0 x0', '0x1111', '', '   ', 'x']) {
  const { adapter, reads } = localHarness();
  await assert.rejects(adapter.evaluate(expression), unsupported(expression), `${JSON.stringify(expression)} stays unsupported`);
  assert.deepEqual(reads, []);
}

for (const expression of [
  ['x0'],
  [],
  ['pc', 'x0'],
  { toString() { return 'pc'; } },
  { toString() { return 'x0'; }, valueOf() { return 'x0'; } },
  Object.assign(Object.create(null), { toString: () => 'sp' }),
  true,
  false,
  0,
  8192,
  0x1111n,
  null,
  undefined,
  Symbol('x0'),
  () => 'pc',
]) {
  const { adapter, reads } = localHarness();
  await assert.rejects(adapter.evaluate(expression), unsupported(String(typeof expression)), `${typeof expression} structured input must not reach getRegister`);
  assert.deepEqual(reads, [], `${String(typeof expression)} must not be promoted to a register read`);
}

{
  let coerced = 0;
  const expression = { toString() { coerced++; return 'pc'; } };
  const { adapter, reads } = localHarness();
  await assert.rejects(adapter.evaluate(expression), unsupported('coercion probe'));
  assert.equal(coerced, 0, 'the type boundary must not stringify raw input');
  assert.deepEqual(reads, []);
}

console.log('local sandbox evaluate expression type boundary #4909: ok');
