import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { EMBED_PROTOCOL, EMBED_PROTOCOL_VERSION, createRpcClient } from '../js/userscript/embed-protocol.js';
import { createChatGPTParentRpc } from '../js/userscript/chatgpt-parent-rpc.js';
import { isPlainData, clonePlainData } from '../js/userscript/embed-bridge-proxy.js';

await testCanonicalIndicesPreserved();
await testSparseHolesPreserved();
await testOutOfRangeNumericKeysRejected();
await testHugeKeyNotMovedToRoundedKey();
await testExistingRejectionsPreserved();
await testWireArrayRejectsHugeKey();
console.log('userscript issue 4968 array key precision: ok');

function defineKey(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
  return target;
}

async function testCanonicalIndicesPreserved() {
  assert.equal(isPlainData([1, 'x', null, true]), true);
  assert.deepEqual(clonePlainData([1, 'x', null, true]), [1, 'x', null, true]);
  const dense = [];
  dense[0] = 'a'; dense[1] = 'b'; dense[123] = 'c';
  assert.equal(isPlainData(dense), true);
  const cloned = clonePlainData(dense);
  assert.equal(cloned.length, 124);
  assert.equal(cloned[0], 'a');
  assert.equal(cloned[1], 'b');
  assert.equal(cloned[123], 'c');
  assert.equal(Object.prototype.hasOwnProperty.call(cloned, '0'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(cloned, '123'), true);
  assert.equal(isPlainData(defineKey([], '4294967294', 'max-index')), true);
}

async function testSparseHolesPreserved() {
  const sparse = []; sparse[2] = 'x';
  assert.equal(isPlainData(sparse), true);
  const cloned = clonePlainData(sparse);
  assert.equal(cloned.length, 3);
  assert.equal(Object.prototype.hasOwnProperty.call(cloned, '0'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(cloned, '1'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(cloned, '2'), true);
  assert.equal(cloned[2], 'x');
}

async function testOutOfRangeNumericKeysRejected() {
  for (const key of ['4294967295', '9007199254740993', '1'.repeat(30)]) {
    const value = defineKey([], key, 'sentinel');
    assert.equal(isPlainData(value), false, `expected canonical-index bound to reject key ${key}`);
    assert.throws(() => clonePlainData(value), TypeError);
  }
}

async function testHugeKeyNotMovedToRoundedKey() {
  const input = defineKey([], '9007199254740993', 'sentinel');
  assert.equal(isPlainData(input), false);
  assert.throws(() => clonePlainData(input), TypeError);
  let moved = true;
  try {
    const cloned = clonePlainData(input);
    moved = Object.prototype.hasOwnProperty.call(cloned, '9007199254740992') && cloned['9007199254740992'] === 'sentinel';
  } catch {
    moved = false;
  }
  assert.equal(moved, false, 'a rounded different key must never receive the value');
}

async function testExistingRejectionsPreserved() {
  const accessor = [];
  Object.defineProperty(accessor, '0', { get() { return 1; }, enumerable: true, configurable: true });
  assert.equal(isPlainData(accessor), false);
  const sym = [];
  Object.defineProperty(sym, Symbol('s'), { value: 1, enumerable: true, configurable: true, writable: true });
  assert.equal(isPlainData(sym), false);
  assert.equal(isPlainData(new Uint8Array([1])), false);
  assert.equal(isPlainData(new ArrayBuffer(4)), false);
  assert.equal(isPlainData(JSON.parse('{"__proto__":{"x":1}}')), false);
  assert.equal(isPlainData(defineKey([], 'constructor', 1)), false);
}

async function testWireArrayRejectsHugeKey() {
  const bridge = {
    request: async () => ({}),
    cancel() {},
    capabilities: async () => ({}),
    getSelection: () => ({}),
    setSelection: async (selection) => selection,
    status() { return defineKey([], '9007199254740993', 'sentinel'); },
    conversationFor: () => null,
  };
  const channel = new MessageChannel();
  const parent = createChatGPTParentRpc({ port: channel.port1, bridge });
  const client = createRpcClient(channel.port2, { timeoutMs: 300 });
  await assert.rejects(client.call('chatgpt.status'), (error) => error.code === 'RPC_UNSAFE_RESULT');
  client.close(); parent.close();

  const okBridge = { ...bridge, status: () => { const a = []; a[0] = 'x'; a[2] = 'y'; return a; } };
  const okChannel = new MessageChannel();
  const okParent = createChatGPTParentRpc({ port: okChannel.port1, bridge: okBridge });
  const okClient = createRpcClient(okChannel.port2, { timeoutMs: 300 });
  const result = await okClient.call('chatgpt.status');
  assert.equal(Array.isArray(result), true);
  assert.equal(result[0], 'x');
  assert.equal(result[2], 'y');
  assert.equal(Object.prototype.hasOwnProperty.call(result, '1'), false);
  okClient.close(); okParent.close();
}
