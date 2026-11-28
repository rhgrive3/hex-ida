import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeAIInteraction,
  normalizeAITurnRequest,
  rejectBinaryPayload,
  sanitizeToolSchema,
  sanitizeValue,
} from '../js/ai/provider/worker-protocol.js';
import {
  ChatGPTWebProvider,
  UserscriptAIProvider,
  parseChatGPTDecision,
} from '../js/ai/provider/chatgpt-web.js';
import { createHexToolRegistry } from '../js/ai/tools/registry.js';

// =============================================================================
// 1. worker-protocol.js
// =============================================================================
test('worker-protocol: sanitizeToolSchema strips non-primitive enum, omits empty enum, rejects non-finite numbers', () => {
  const schema = sanitizeToolSchema({
    type: 'object',
    minimum: NaN,
    maximum: Infinity,
    minLength: 3,
    properties: {
      mixed: {
        type: 'string',
        enum: ['ok', 42, true, null, NaN, Infinity, { nested: 1 }, [1, 2], new Uint8Array([1])],
      },
      allBad: {
        type: 'string',
        enum: [{ bad: true }, NaN, Infinity],
      },
    },
  });
  assert.equal(schema.minimum, undefined);
  assert.equal(schema.maximum, undefined);
  assert.equal(schema.minLength, 3);
  assert.deepEqual(schema.properties.mixed.enum, ['ok', 42, true, null]);
  assert.equal(Object.hasOwn(schema.properties.allBad, 'enum'), false, 'empty enum must be omitted');
});

test('worker-protocol: normalizeAITurnRequest rejects binary payloads in tools/messages, DAG guard, sanitizeValue non-finite, allowedTools guard', () => {
  // Binary payload in tools rejected
  assert.throws(() => normalizeAITurnRequest({
    context: { request: { goal: 'inspect' } },
    tools: [{ name: 'my_tool', description: 'd', inputSchema: { enum: [new Uint8Array([1, 2])] } }],
  }), /binary_upload_forbidden|Binary content/);

  // Binary payload in messages rejected
  assert.throws(() => normalizeAITurnRequest({
    context: { request: { goal: 'inspect' } },
    messages: [{ role: 'user', content: new Uint8Array([1, 2]) }],
  }), /binary_upload_forbidden|Binary content/);

  // Shared DAG completes fast without exponential blowup
  let node = { leaf: 'ok' };
  for (let i = 0; i < 8; i++) {
    node = { a: node, b: node, c: node, d: node, e: node };
  }
  assert.doesNotThrow(() => rejectBinaryPayload(node));

  // sanitizeValue excludes NaN / Infinity
  assert.deepEqual(sanitizeValue({ ok: 1.5, bad1: NaN, bad2: Infinity, bad3: -Infinity }, 0), { ok: 1.5 });

  // normalizeAIInteraction guards non-array allowedTools
  assert.throws(() => normalizeAIInteraction({
    steps: [{ type: 'tool_call', name: 'get_function', arguments: {} }],
  }, null), /The model requested an unknown tool/);
});

// =============================================================================
// 2. chatgpt-web.js
// =============================================================================
test('chatgpt-web: parseChatGPTDecision rejects Array, timeoutMs fallback aborts hung bridge', async () => {
  assert.throws(() => parseChatGPTDecision([1, 2, 3]), /non-object JSON value/);

  const provider = new ChatGPTWebProvider({
    bridge: {
      request: (_prompt, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    },
  });
  await assert.rejects(
    () => provider.nextTurn({ sessionId: 's1', tools: [] }, { timeoutMs: 25 }),
    (err) => err?.type === 'budget_exhausted',
  );
  assert.equal(provider.controllers.size, 0);
});

test('chatgpt-web: UserscriptAIProvider isolates prepareCapabilities/capabilities failures, protects fields, guards setSelection race, validates apiEndpoint', async () => {
  const prevProvider = globalThis.__HEX_AI_PROVIDER__;
  const prevBase = globalThis.__HEX_API_BASE__;
  try {
    globalThis.__HEX_AI_PROVIDER__ = 'corrupted-unknown-provider';
    globalThis.__HEX_API_BASE__ = 'javascript:alert(1)';

    let resolveChatgptSelect;
    const chatgptBridge = {
      request: async () => '{"type":"final","answer":"ok"}',
      capabilities: async () => { throw new Error('bridge-down'); },
      status: () => ({ ready: true }),
      setSelection: () => new Promise((resolve) => { resolveChatgptSelect = resolve; }),
    };
    const failingFetch = async () => { throw new Error('worker-offline'); };

    const up = new UserscriptAIProvider({ bridge: chatgptBridge, fetchImpl: failingFetch });
    // apiEndpoint rejected javascript: scheme and kept relative path
    assert.equal(up.gemini.endpoint, '/api/ai/turn');

    // status() & getSelection() survive corrupted __HEX_AI_PROVIDER__
    assert.equal(up.status().provider, 'chatgpt-web');
    assert.equal(up.getSelection().provider, 'chatgpt-web');

    // prepareCapabilities isolates child failure
    await assert.doesNotReject(() => up.prepareCapabilities());

    // capabilities() isolates bridge rejection and returns both providers
    const caps = await up.capabilities();
    assert.equal(caps.providers.length, 2);
    assert.equal(caps.providers[0].id, 'chatgpt-web');
    assert.equal(caps.providers[1].id, 'gemini');

    // Bridge cannot spoof id/displayName or force available:true when bridge.request is absent
    const spoofed = new UserscriptAIProvider({
      bridge: {
        capabilities: async () => ({ id: 'spoof', displayName: 'Fake', available: true, extra: 1 }),
      },
      fetchImpl: failingFetch,
    });
    const spoofCaps = await spoofed.capabilities();
    assert.equal(spoofCaps.providers[0].id, 'chatgpt-web');
    assert.equal(spoofCaps.providers[0].displayName, 'ChatGPT Web');
    assert.equal(spoofCaps.providers[0].available, false);
    assert.equal(spoofCaps.providers[0].extra, 1);

    // setSelection race: slower chatgpt selection must NOT overwrite newer gemini selection
    const pChatgpt = up.setSelection({ provider: 'chatgpt-web', model: 'gpt-5' });
    await up.setSelection({ provider: 'gemini' });
    assert.equal(globalThis.__HEX_AI_PROVIDER__, 'gemini');
    resolveChatgptSelect({ model: 'gpt-5' });
    await pChatgpt;
    assert.equal(globalThis.__HEX_AI_PROVIDER__, 'gemini');
  } finally {
    if (prevProvider === undefined) delete globalThis.__HEX_AI_PROVIDER__;
    else globalThis.__HEX_AI_PROVIDER__ = prevProvider;
    if (prevBase === undefined) delete globalThis.__HEX_API_BASE__;
    else globalThis.__HEX_API_BASE__ = prevBase;
  }
});

// =============================================================================
// 3. registry.js + registry-base.js
// =============================================================================
test('registry-base: boundedResult enforces complete=false on truncation and preserves primary array total/returned', async () => {
  const reg = createHexToolRegistry({
    findConstant: async () => ({
      results: Array.from({ length: 10 }, (_, i) => ({ address: `0x${(0x1000 + i * 4).toString(16)}` })),
      functions: [{ address: '0x1000' }, { address: '0x2000' }],
      complete: true,
      truncated: false,
    }),
  });
  // Direct call to find_constant with limit=3 via legacy override
  reg.legacyTools.find_constant = async () => ({
    results: Array.from({ length: 10 }, (_, i) => ({ id: i })),
    functions: [{ id: 'f1' }, { id: 'f2' }],
    complete: true,
    truncated: false,
  });
  const out = await reg.get('find_constant').execute({ value: 42, functions: ['0x1000'], limit: 3 });
  assert.equal(out.results.length, 3);
  assert.equal(out.returned, 3, 'primary array (results) must govern returned, not secondary functions');
  assert.equal(out.total, 10);
  assert.equal(out.truncated, true);
  assert.equal(out.complete, false, 'truncated=true must force complete=false');
  assert.equal(out.reason, 'result-limit');
});

test('registry-base: analysisContext.analyze inFlight reservation handles end==null parallel calls and accounts actual cost on budget exceed', async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const reg = createHexToolRegistry({
    architecture: 'arm64',
    analyze: async (addr) => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      // Return 60 instructions per call
      return {
        address: addr,
        instructions: Array.from({ length: 60 }, (_, i) => ({ address: BigInt(addr) + BigInt(i * 4), mnemonic: 'nop', operands: '' })),
      };
    },
  }, { maxDisassembly: 100 });

  // Two parallel calls with end==null: reserved=1 each so both can run concurrently,
  // first consumes 60 (ok), second consumes 60 (> remaining 40) -> throws AND records cost!
  const results = await Promise.allSettled([
    reg.legacyTools.__loader.get(0x1000n),
    reg.legacyTools.__loader.get(0x2000n),
  ]);
  assert.equal(maxActive, 2, 'end==null parallel calls must not falsely block each other');
  assert.equal(calls, 2);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  assert.equal(reg.analysisStats.disassembly, 120, 'actual cost must be accounted even when exceeding budget');

  // Subsequent call must be rejected immediately because budget is exhausted
  await assert.rejects(() => reg.legacyTools.__loader.get(0x3000n), /disassembly-budget/);
});

test('registry-base: decompileFunction undefined guard, projectSearchLocal cycle/binary/cap guard, signal forwarding, and clean keys', async () => {
  let receivedSignal = null;
  const reg = createHexToolRegistry({
    decompile: async (_addr, opts) => {
      receivedSignal = opts?.signal ?? null;
      return undefined;
    },
    getCFG: async () => ({ blocks: [{ id: 0 }], complete: true }),
    getBinaryDiff: async () => ({ functions: [{ address: '0x1000' }], complete: true }),
    project: (() => {
      const cyc = { note: 'hello world', bin: new Uint8Array([0x41, 0x42]) };
      cyc.self = cyc;
      return cyc;
    })(),
  });

  const ac = new AbortController();
  const dec = await reg.get('decompile_function').execute({ functionAddress: '0x1000' }, { signal: ac.signal });
  assert.equal(dec.pseudocodeExcerpt, '');
  assert.equal(receivedSignal, ac.signal);

  const cfg = await reg.get('get_cfg').execute({ functionAddress: '0x1000' });
  assert.equal(Object.hasOwn(cfg, 'results'), false, 'getCfg must not leave results: undefined property');

  const diff = await reg.get('get_binary_diff').execute({});
  assert.equal(Object.hasOwn(diff, 'results'), false, 'binaryDiff must not leave results: undefined property');

  const proj = await reg.get('project_search').execute({ query: 'hello', limit: 10 });
  assert.equal(proj.results.length, 1);
  assert.equal(proj.complete, true);

  // Invalid functionAddress in find_global_accesses raises AIError('invalid_tool_call')
  await assert.rejects(
    () => reg.get('find_global_accesses').execute({ functionAddress: 'not-a-hex' }),
    (err) => err?.type === 'invalid_tool_call',
  );
});

// =============================================================================
// 4. registry.js & registry-query-base.js
// =============================================================================
test('registry & registry-query-base: AnalysisQueryAPI decompile string, continuation out.offset, anchor abort/non-numeric, malformed related suppression', async () => {
  let instructionCalls = 0;
  const reg = createHexToolRegistry({
    analysisAuthority: 'AnalysisQueryAPI',
    getDecompile: async () => 'int main() { return 0; }',
    getInstructions: async () => {
      instructionCalls++;
      return { results: [{ id: 1, address: '0x1000', mnemonic: 'ret', operands: '' }], complete: false };
    },
    getXrefs: async () => ({ results: [{ from: '0x2000' }, { from: '0x2004' }], offset: 10 }),
    getCallers: async () => {
      const bad = { results: [], offset: 5, complete: false, truncated: true };
      Object.defineProperty(bad, 'nextOffset', { value: 24, enumerable: false });
      return bad;
    },
    getCallees: async () => ({ results: [], offset: 0, complete: true, truncated: false, total: 0 }),
  });

  // decompile_function handles plain string from getDecompile
  const dec = await reg.get('decompile_function').execute({ functionAddress: '0x1000' });
  assert.equal(dec.pseudocodeExcerpt, 'int main() { return 0; }');
  assert.equal(dec.complete, true);

  // Non-numeric aroundInstructionId exits immediately without 40-page scan
  const badAnchor = await reg.get('inspect_function_region').execute({
    functionAddress: '0x1000',
    view: 'assembly',
    aroundInstructionId: 'non-numeric-id',
  });
  assert.equal(badAnchor.reason, 'anchor-unresolved');
  assert.equal(instructionCalls, 0);

  // Aborted signal stops anchor scan immediately
  const ac = new AbortController();
  ac.abort('user-cancelled');
  await assert.rejects(
    () => reg.get('inspect_function_region').execute({
      functionAddress: '0x1000',
      view: 'assembly',
      aroundInstructionId: 99,
    }, { signal: ac.signal }),
    (err) => err === 'user-cancelled',
  );
  assert.equal(instructionCalls, 0);

  // continuation uses out.offset (10 + 2 = 12) and normalizes complete/truncated
  const xrefs = await reg.get('get_xrefs').execute({ address: '0x1000', limit: 2 });
  assert.equal(xrefs.complete, false);
  assert.equal(xrefs.truncated, true);
  assert.ok(xrefs.continuation?.cursor);
  const decodedCursor = reg.observationStore.cursorCodec.decode(xrefs.continuation.cursor, {
    bindingKey: reg.observationStore.binding().key,
    kind: 'tool-page',
  });
  assert.equal(decodedCursor.offset, 12);

  // Malformed callers side must NOT re-mint a continuation from nextOffset
  const related = await reg.get('get_related_functions').execute({ functionAddress: '0x1000', limit: 99999 });
  assert.equal(related.callersPage.reason, 'malformed-completeness');
  assert.equal(related.continuations?.callers, undefined);

  // Verifier handlers with undefined args throw AIError('invalid_tool_call')
  await assert.rejects(
    () => reg.get('verify_edge_feasibility').execute(undefined),
    (err) => err?.type === 'invalid_tool_call',
  );
});
