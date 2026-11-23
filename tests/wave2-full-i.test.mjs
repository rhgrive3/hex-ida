import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHexToolRegistry } from '../js/ai/tools/registry-base.js';
import { createHexAIContext } from '../js/ai/ui/hex-context.js';
import { configureScopedAnalysisHost } from '../js/analysis/query/scoped-host.js';

function makeInstructions(count, startAddr = 0x1000n) {
  return Array.from({ length: count }, (_, i) => ({
    address: startAddr + BigInt(i * 4),
    mnemonic: 'nop',
    operands: '',
    bytes: new Uint8Array([0x1f, 0x20, 0x03, 0xd5]),
  }));
}

test('Issue 1: attachContinuation imports resultCount and uses it when returned is absent', async () => {
  const registryBaseUrl = new URL('../js/ai/tools/registry-base.js', import.meta.url).href;
  const loaderSource = `
export async function load(url, ctx, next) {
  if (url.endsWith('/js/agent/tools.js')) {
    return {
      format: 'module',
      shortCircuit: true,
      source: \`
        export const compactFact = (x) => x;
        export function createAgentTools() {
          return {
            get_callers: async () => ({
              results: [{ addr: 0x2000n }, { addr: 0x2004n }, { addr: 0x2008n }],
              total: 5,
              truncated: true,
            }),
            get_xrefs: async () => ({
              sites: [{ from: 0x2000n, to: 0x1000n }, { from: 0x2004n, to: 0x1000n }],
              total: 4,
              returned: null,
              truncated: true,
            }),
            get_callees: async () => ({
              results: [{ addr: 0x3000n }, { addr: 0x3004n }],
              total: 2,
              truncated: false,
            }),
          };
        }
      \`,
    };
  }
  return next(url, ctx);
}
`;
  const loaderUrl = `data:text/javascript;base64,${Buffer.from(loaderSource, 'utf8').toString('base64')}`;
  const evalScript = `
    import { createHexToolRegistry } from ${JSON.stringify(registryBaseUrl)};
    const registry = createHexToolRegistry({});
    const missingReturned = await registry.execute('get_callers', { address: '0x1000', limit: 3 });
    const nullReturned = await registry.execute('get_xrefs', { address: '0x1000', limit: 2 });
    const completeWithoutReturned = await registry.execute('get_callees', { address: '0x1000', limit: 5 });
    process.stdout.write(JSON.stringify({
      missingReturned: {
        tool: missingReturned.tool,
        returned: missingReturned.result.returned,
        complete: missingReturned.result.complete,
        truncated: missingReturned.result.truncated,
        hasCursor: Boolean(missingReturned.result.continuation?.cursor),
      },
      nullReturned: {
        tool: nullReturned.tool,
        returned: nullReturned.result.returned,
        complete: nullReturned.result.complete,
        truncated: nullReturned.result.truncated,
        hasCursor: Boolean(nullReturned.result.continuation?.cursor),
      },
      completeWithoutReturned: {
        tool: completeWithoutReturned.tool,
        returned: completeWithoutReturned.result.returned,
        complete: completeWithoutReturned.result.complete,
        truncated: completeWithoutReturned.result.truncated,
        hasCursor: Boolean(completeWithoutReturned.result.continuation?.cursor),
      },
    }));
  `;

  const stdout = execFileSync(
    process.execPath,
    ['--no-warnings', '--loader', loaderUrl, '--input-type=module', '-e', evalScript],
    { encoding: 'utf8' },
  );
  const { missingReturned, nullReturned, completeWithoutReturned } = JSON.parse(stdout);

  // Case 1: out.returned is undefined -> attachContinuation falls back to resultCount(out) (results.length === 3)
  assert.equal(missingReturned.tool, 'get_callers');
  assert.equal(missingReturned.returned, 3);
  assert.equal(missingReturned.complete, false);
  assert.equal(missingReturned.truncated, true);
  assert.equal(missingReturned.hasCursor, true, 'continuation cursor should be attached when returned is undefined');

  // Case 2: out.returned is null -> attachContinuation falls back to resultCount(out) (sites.length === 2)
  assert.equal(nullReturned.tool, 'get_xrefs');
  assert.equal(nullReturned.returned, 2);
  assert.equal(nullReturned.complete, false);
  assert.equal(nullReturned.truncated, true);
  assert.equal(nullReturned.hasCursor, true, 'continuation cursor should be attached when returned is null');

  // Case 3: out.returned is undefined and truncated is false with offset + resultCount(out) >= total -> complete: true
  assert.equal(completeWithoutReturned.tool, 'get_callees');
  assert.equal(completeWithoutReturned.returned, 2);
  assert.equal(completeWithoutReturned.complete, true);
  assert.equal(completeWithoutReturned.truncated, false);
  assert.equal(completeWithoutReturned.hasCursor, false, 'complete result should not attach continuation cursor');
});

test('Issue 2: hex-context scopedMethods allows all 6 demand-precision methods', async () => {
  const demandMethods = [
    'demandInvestigationFrontier',
    'investigateDemand',
    'demandQuery',
    'resumeDemandQuery',
    'explainDemandResult',
    'replayDemandResult',
  ];

  const called = [];
  const analysisQueries = {
    snapshot: async () => ({ id: 'snap-1' }),
    scopedSnapshot: async () => ({ id: 'scoped-snap-1' }),
    ...Object.fromEntries(
      demandMethods.map((method) => [
        method,
        async (snapshot, request) => {
          called.push({ method, snapshot, request });
          return { value: { ok: true, method }, completeness: 'complete' };
        },
      ]),
    ),
  };

  const app = { analysisQueries };
  configureScopedAnalysisHost(app, { enabled: true });

  const ctx = createHexAIContext(app);
  assert.equal(typeof ctx.runScopedAnalysis, 'function');

  for (const method of demandMethods) {
    const res = await ctx.runScopedAnalysis(method, { artifactId: 'art-1' });
    assert.equal(res.value.ok, true);
    assert.equal(res.value.method, method);
    assert.equal(res.analysisAuthority, 'AnalysisQueryAPI');
  }

  assert.deepEqual(
    called.map((c) => c.method),
    demandMethods,
  );

  await assert.rejects(
    () => ctx.runScopedAnalysis('nonExistentMethod', {}),
    { name: 'TypeError', message: 'scoped-ai-method-not-allowed' },
  );
});

test('Issue 3: analysisContext.analyze prevents TOCTOU budget bypass under concurrent Promise.all calls', async () => {
  let releaseFirst;
  let releaseSecond;
  const firstEntered = new Promise((r) => { releaseFirst = r; });
  const secondEntered = new Promise((r) => { releaseSecond = r; });

  let analyzeCallCount = 0;
  const registry = createHexToolRegistry({
    analyze: async (address) => {
      analyzeCallCount += 1;
      const idx = analyzeCallCount;
      const addr = BigInt(address);
      if (idx === 1) {
        releaseFirst();
        await secondEntered;
      } else {
        releaseSecond();
        await firstEntered;
        // Ensure call 1 completes and consumes budget first
        await new Promise((r) => setTimeout(r, 15));
      }
      return {
        address: addr,
        name: `fn_${addr.toString(16)}`,
        instructions: makeInstructions(60, addr),
      };
    },
  }, { maxDisassembly: 100 });

  const results = await Promise.allSettled([
    registry.execute('find_global_accesses', { functionAddress: '0x1000' }),
    registry.execute('find_global_accesses', { functionAddress: '0x2000' }),
  ]);

  assert.equal(analyzeCallCount, 2, 'both concurrent calls should have reached context.analyze');
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');

  assert.equal(fulfilled.length, 1, 'exactly one concurrent call should fit within maxDisassembly=100');
  assert.equal(rejected.length, 1, 'second concurrent call must fail with disassembly-budget');
  assert.match(String(rejected[0].reason?.message || rejected[0].reason), /disassembly-budget/);
});
