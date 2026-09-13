import assert from 'node:assert/strict';
import { handleAITurn } from '../js/ai/provider/worker-turn.js';

const BODY = JSON.stringify({
  sessionId:'s', mode:'chat', style:'analyst', requestedScope:'auto', effectiveScope:'binary',
  context:{ request:{ goal:'x' } }, tools:[],
});
const OK_UPSTREAM = () => new Response(
  JSON.stringify({ steps:[{ type:'function_call', name:'submit_hex_result', arguments:{ answer:'ok' } }] }),
  { status:200 },
);

function turnRequest(signal) {
  return {
    method:'POST',
    headers:new Headers({ 'content-type':'application/json', 'cf-connecting-ip':'1.2.3.4' }),
    body:new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(BODY)); controller.close(); } }),
    signal,
  };
}

function envWith(quota) {
  return { GEMINI_API_KEY:'x', AI_QUOTA:{ getByName:() => quota } };
}

// A client abort that lands before the disconnect listener is registered must
// never dispatch the abort event to that late listener, so the handler has to
// re-check the current value after subscribing (#5626).
function signalAbortedAtSubscription() {
  return {
    get aborted() { return this._aborted === true; },
    addEventListener() { this._aborted = true; },
    removeEventListener() {},
  };
}

{
  let upstreamCalls = 0;
  let releases = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls++; return OK_UPSTREAM(); };
  try {
    const response = await handleAITurn(
      turnRequest(signalAbortedAtSubscription()),
      envWith({ acquire:async () => ({ allowed:true, token:'lease-1' }), release:async () => { releases++; return {}; } }),
    );
    assert.equal(upstreamCalls, 0, 'a client that already disconnected must not start provider inference');
    assert.equal(releases, 1, 'the granted quota lease must be released exactly once');
    assert.equal(response.status, 499, `an already-cancelled turn must terminate, got ${response.status}`);
  } finally { globalThis.fetch = originalFetch; }
}

{
  let upstreamCalls = 0;
  let releases = 0;
  const signal = { aborted:false, addEventListener() {}, removeEventListener() {} };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalls++; return OK_UPSTREAM(); };
  try {
    const response = await handleAITurn(
      turnRequest(signal),
      envWith({ acquire:async () => ({ allowed:true, token:'lease-1' }), release:async () => { releases++; return {}; } }),
    );
    assert.equal(response.status, 200, 'a connected client must still complete the turn');
    assert.equal(upstreamCalls, 1);
    assert.equal(releases, 1);
  } finally { globalThis.fetch = originalFetch; }
}

{
  const controller = new AbortController();
  let upstreamCalls = 0;
  let releases = 0;
  let upstreamSignal = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { upstreamCalls++; upstreamSignal = init?.signal || null; controller.abort(new Error('Client disconnected.')); return OK_UPSTREAM(); };
  try {
    const response = await handleAITurn(
      turnRequest(controller.signal),
      envWith({ acquire:async () => ({ allowed:true, token:'lease-1' }), release:async () => { releases++; return {}; } }),
    );
    assert.equal(upstreamCalls, 1);
    assert.equal(upstreamSignal?.aborted, true, 'the in-flight upstream request must observe the disconnect');
    assert.notEqual(response.status, undefined);
    assert.equal(releases, 1, 'abort plus completion must release the lease only once');
  } finally { globalThis.fetch = originalFetch; }
}

console.log('issue #5626 worker-turn abort boundary regressions PASS');
