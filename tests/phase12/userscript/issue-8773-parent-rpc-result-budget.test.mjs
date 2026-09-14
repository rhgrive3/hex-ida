import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageChannel } from 'node:worker_threads';

import { createRpcClient } from '../../../js/userscript/embed-protocol.js';
import { createChatGPTParentRpc } from '../../../js/userscript/chatgpt-parent-rpc.js';

const MAX_WIRE_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_WIRE_CHILDREN = 65536;
const TEXT_KEY_BYTES = 4; // { text }

function fakeBridge(overrides = {}) {
  return {
    request: async () => ({ text: 'ok', conversation: null, selection: null, turnId: 't' }),
    cancel() {},
    capabilities: async () => ({ provider: 'chatgpt-web', models: [] }),
    getSelection: () => ({ model: null, reasoning: null }),
    setSelection: async (s) => s,
    status: () => ({ ready: true }),
    conversationFor: () => null,
    ...overrides,
  };
}

function pair(bridge) {
  const channel = new MessageChannel();
  const parent = createChatGPTParentRpc({ port: channel.port1, bridge });
  const client = createRpcClient(channel.port2, { timeoutMs: 4000 });
  return { parent, client, close() { try { client.close(); } catch {} try { parent.close(); } catch {} } };
}

async function withPair(bridge, body) {
  const p = pair(bridge);
  try { return await body(p); } finally { p.close(); }
}

test('#8773 an oversized page-derived request string is rejected before it is cloned to the receiver', async () => {
  await withPair(fakeBridge({ request: async () => ({ text: 'x'.repeat(16 * 1024 * 1024), turnId: 't' }) }),
    async (p) => {
      await assert.rejects(p.client.call('chatgpt.request', { prompt: 'p', sessionKey: 's1' }),
        (error) => error.code === 'RPC_UNSAFE_RESULT', 'a 16 MiB result must not cross the parent RPC boundary');
    });
});

test('#8773 aggregate byte budget uses deterministic UTF-8 boundary semantics', async () => {
  const asciiAtCap = 'a'.repeat(MAX_WIRE_RESULT_BYTES - TEXT_KEY_BYTES);
  const asciiOverCap = 'a'.repeat(MAX_WIRE_RESULT_BYTES - TEXT_KEY_BYTES + 1);
  const wideAtCap = '\u00e9'.repeat((MAX_WIRE_RESULT_BYTES - TEXT_KEY_BYTES) / 2); // 2 bytes/char
  const wideOverCap = '\u00e9'.repeat((MAX_WIRE_RESULT_BYTES - TEXT_KEY_BYTES) / 2 + 1);

  for (const [text, accept] of [[asciiAtCap, true], [asciiOverCap, false], [wideAtCap, true], [wideOverCap, false]]) {
    await withPair(fakeBridge({ status: () => ({ text }) }), async (p) => {
      if (accept) assert.deepEqual(await p.client.call('chatgpt.status'), { text });
      else await assert.rejects(p.client.call('chatgpt.status'), (error) => error.code === 'RPC_UNSAFE_RESULT');
    });
  }
});

test('#8773 a wide array or object above the entry ceiling fails before the complete graph is copied', async () => {
  await withPair(fakeBridge({ status: () => ({ items: new Array(MAX_WIRE_CHILDREN + 1).fill(1) }) }),
    async (p) => {
      await assert.rejects(p.client.call('chatgpt.status'), (error) => error.code === 'RPC_UNSAFE_RESULT');
    });

  const wide = Object.create(null);
  for (let i = 0; i <= MAX_WIRE_CHILDREN; i += 1) wide[`k${i}`] = i;
  await withPair(fakeBridge({ status: () => wide }), async (q) => {
    await assert.rejects(q.client.call('chatgpt.status'), (error) => error.code === 'RPC_UNSAFE_RESULT');
  });
});

test('#8773 normal request / capabilities / status payloads are unchanged and still cross the boundary', async () => {
  await withPair(fakeBridge(), async (p) => {
    assert.deepEqual(await p.client.call('chatgpt.request', { prompt: 'hi', sessionKey: 's1' }),
      { text: 'ok', conversation: null, selection: null, turnId: 't' });
    assert.deepEqual(await p.client.call('chatgpt.capabilities', {}), { provider: 'chatgpt-web', models: [] });
    assert.deepEqual(await p.client.call('chatgpt.status'), { ready: true });
  });
});

test('#8773 depth, cycles, DOM-like and dangerous-key records remain fail-closed under the budget', async () => {
  const deep = (() => { let node = { leaf: true }; for (let i = 0; i < 200; i += 1) node = { nested: node }; return node; })();
  const cyclic = {}; cyclic.self = cyclic;
  for (const [value, label] of [[deep, 'deep'], [cyclic, 'cycle'], [{ nodeType: 1, nodeName: 'DIV' }, 'dom'], [{ __proto__: {} }, 'proto']]) {
    await withPair(fakeBridge({ status: () => value }), async (p) => {
      await assert.rejects(p.client.call('chatgpt.status'), (error) => error.code === 'RPC_UNSAFE_RESULT', label);
    });
  }
});
