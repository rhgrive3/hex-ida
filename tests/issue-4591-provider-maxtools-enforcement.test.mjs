import assert from 'node:assert/strict';
import worker from '../worker.js';
import { clientSafeCapabilities } from '../js/ai/provider/worker-adapters.js';

let quotaSerial = 0;
const ALLOW_QUOTA = { getByName: () => ({ async acquire() { return { allowed: true, token: `t-${++quotaSerial}` }; }, async release() { return { released: true }; } }) };

const CLIENT_TOOL = (n) => ({ name: n, description: `tool ${n}`, inputSchema: { type: 'object' } });

function turnRequest(tools, mode = 'chat') {
  return new Request('https://example.test/api/ai/turn', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, style: 'analyst', scope: 'auto', context: { request: { goal: 'Explain ASLR' } }, messages: [], tools }),
  });
}

function captureUpstream() {
  const seen = [];
  globalThis.fetch = async (_url, options) => {
    seen.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ steps: [{ type: 'function_call', name: 'submit_hex_result', arguments: { answer: 'ok', evidenceIds: [] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return seen;
}

const originalFetch = globalThis.fetch;
try {
  // req1: maxTools=2 + 2 client tools must NOT forward 3 tools (final tool included) upstream.
  {
    const seen = captureUpstream();
    const response = await worker.fetch(turnRequest([CLIENT_TOOL('tool_a'), CLIENT_TOOL('tool_b')]), {
      GEMINI_API_KEY: 'server-only', GEMINI_TOOL_LIMIT: '2', AI_QUOTA: ALLOW_QUOTA, ASSETS: { fetch: () => new Response('asset') },
    });
    assert.equal(seen.length, 0, 'a request that would exceed the provider budget must not reach upstream');
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, 'tool_budget_exceeded');
  }

  // req2: maxTools=2 + 1 client tool succeeds with exactly 2 tools (client + final).
  {
    const seen = captureUpstream();
    const response = await worker.fetch(turnRequest([CLIENT_TOOL('tool_a')]), {
      GEMINI_API_KEY: 'server-only', GEMINI_TOOL_LIMIT: '2', AI_QUOTA: ALLOW_QUOTA, ASSETS: { fetch: () => new Response('asset') },
    });
    assert.equal(response.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].tools.length, 2);
    assert.equal(seen[0].tools.filter((tool) => tool.name === 'submit_hex_result').length, 1);
  }

  // req3: maxTools=1 -> only the final-result tool is admissible; a single client tool is rejected.
  {
    const seen = captureUpstream();
    const empty = await worker.fetch(turnRequest([]), {
      GEMINI_API_KEY: 'server-only', GEMINI_TOOL_LIMIT: '1', AI_QUOTA: ALLOW_QUOTA, ASSETS: { fetch: () => new Response('asset') },
    });
    assert.equal(empty.status, 200);
    assert.equal(seen.at(-1).tools.length, 1);
    const rejected = await worker.fetch(turnRequest([CLIENT_TOOL('tool_a')]), {
      GEMINI_API_KEY: 'server-only', GEMINI_TOOL_LIMIT: '1', AI_QUOTA: ALLOW_QUOTA, ASSETS: { fetch: () => new Response('asset') },
    });
    assert.equal(rejected.status, 422);
    assert.equal((await rejected.json()).error.code, 'tool_budget_exceeded');
  }

  // req4: Groq adapter enforces the same total-count constraint.
  {
    const seen = captureUpstream();
    const rejected = await worker.fetch(turnRequest([CLIENT_TOOL('tool_a'), CLIENT_TOOL('tool_b')]), {
      AI_PROVIDER: 'groq', GROQ_API_KEY: 'server-only', GROQ_TOOL_LIMIT: '2', AI_QUOTA: ALLOW_QUOTA, ASSETS: { fetch: () => new Response('asset') },
    });
    assert.equal(rejected.status, 422);
    assert.equal(seen.length, 0);
    const ok = await worker.fetch(turnRequest([CLIENT_TOOL('tool_a')]), {
      AI_PROVIDER: 'groq', GROQ_API_KEY: 'server-only', GROQ_TOOL_LIMIT: '2', AI_QUOTA: ALLOW_QUOTA, ASSETS: { fetch: () => new Response('asset') },
    });
    assert.equal(ok.status, 200);
    assert.equal(seen.at(-1).tools.length, 2);
  }

  // req5: advertised maxTools equals the accepted client-tool budget (provider total minus the reserved final slot).
  {
    const advertised = clientSafeCapabilities({ provider: 'gemini', maxTools: 2, maxRequestBytes: 160000 }).maxTools;
    assert.equal(advertised, 1, 'advertised maxTools must be the client-supplied tool budget');
    const seen = captureUpstream();
    const fit = await worker.fetch(turnRequest([CLIENT_TOOL('tool_a')]), {
      GEMINI_API_KEY: 'server-only', GEMINI_TOOL_LIMIT: '2', AI_QUOTA: ALLOW_QUOTA, ASSETS: { fetch: () => new Response('asset') },
    });
    assert.equal(fit.status, 200);
    assert.equal(seen.at(-1).tools.length, advertised + 1);
  }

  // req6: the fixed 40-item sanitizer cap must not bypass a smaller provider limit.
  {
    const many = Array.from({ length: 40 }, (_unused, index) => CLIENT_TOOL(`tool_${index}`));
    const seen = captureUpstream();
    const response = await worker.fetch(turnRequest(many), {
      GEMINI_API_KEY: 'server-only', GEMINI_TOOL_LIMIT: '4', AI_QUOTA: ALLOW_QUOTA, ASSETS: { fetch: () => new Response('asset') },
    });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, 'tool_budget_exceeded');
    assert.equal(seen.length, 0);
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log('#4591 provider maxTools enforcement: PASS');
