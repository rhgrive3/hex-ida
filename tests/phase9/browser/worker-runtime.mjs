import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { chromium, webkit } from 'playwright';

const ROOT = process.cwd();

function serveSource(request, response) {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const relative = pathname === '/' ? null : pathname.replace(/^\/+/, '');
  const file = relative ? path.resolve(ROOT, relative) : null;
  if (file && (!file.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile())) {
    response.writeHead(404);
    response.end('not found');
    return;
  }

  const body = file ? fs.readFileSync(file) : '<!doctype html><meta charset="utf-8"><title>Phase 9 worker runtime</title>';
  const contentType = file?.endsWith('.js') ? 'text/javascript' : 'text/html';
  response.writeHead(200, {
    'content-type': `${contentType}; charset=utf-8`,
    'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self'",
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function checkBrowser(name, browserType, baseUrl) {
  const browser = await browserType.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  const context = await browser.newContext({
    viewport: { width: 1024, height: 1366 },
    userAgent: name === 'webkit'
      ? 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1'
      : undefined,
  });
  try {
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async () => {
      const [{ TieredWorkerSolverBackend: WorkerSolverBackend }, kinds, factory, queryApi, edgeVerifier] = await Promise.all([
        import('/js/symbolic/solver/tiered-worker-backend.js'),
        import('/js/symbolic/expr/kinds.js'),
        import('/js/symbolic/expr/factory.js'),
        import('/js/symbolic/verify/query.js'),
        import('/js/symbolic/verify/edge-feasibility.js'),
      ]);
      const { bvSort, BV_BINARY_OP, BV_COMPARE_OP } = kinds;
      const { createBinary, createBv, createCompare, createFreshSymbol } = factory;
      const { CLAIM_KIND, VERIFICATION_QUERY_KIND, createVerificationQuery } = queryApi;
      const backend = new WorkerSolverBackend();
      const modelValue = (model, symbol) => model instanceof Map ? model.get(symbol.symbolId) : model?.[symbol.symbolId];
      const makeQuery = (assertion, constraints = [], targetEntity = 'browser-runtime') => createVerificationQuery({
        kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
        claimKind: CLAIM_KIND.EDGE_FEASIBLE,
        targetEntity,
        constraints,
        assertion,
      });

      // Preserve the <=8-bit exact floor through the production Worker route.
      const x = createFreshSymbol(bvSort(3), 'browser_x');
      const session = backend.createSession({ timeoutMs: 2000 });
      const satQuery = makeQuery(createCompare(BV_COMPARE_OP.EQ, x, createBv(3, 5n)), [], 'browser-narrow-sat');
      const unsatQuery = makeQuery(null, [
        createCompare(BV_COMPARE_OP.EQ, x, createBv(3, 1n)),
        createCompare(BV_COMPARE_OP.EQ, x, createBv(3, 2n)),
      ], 'browser-narrow-unsat');
      const sat = await session.check(satQuery, { timeoutMs: 2000 });
      const unsat = await session.check(unsatQuery, { timeoutMs: 2000 });

      // Exercise both realistic production widths through the bit-blast tier.
      const wideResults = [];
      for (const width of [32, 64]) {
        const wide = createFreshSymbol(bvSort(width), `browser_wide_${width}`);
        const seed = width === 32 ? 0x12345678n : 0x123456789abcdef0n;
        const delta = width === 32 ? 0x10203n : 0x0102030405060708n;
        const expression = createBinary(BV_BINARY_OP.ADD, wide, createBv(width, delta));
        const expected = BigInt.asUintN(width, seed + delta);
        const wideQuery = makeQuery(
          createCompare(BV_COMPARE_OP.EQ, expression, createBv(width, expected)),
          [createCompare(BV_COMPARE_OP.EQ, wide, createBv(width, seed))],
          `browser-wide-${width}`,
        );
        const solved = await session.check(wideQuery, { timeoutMs: 2000 });
        wideResults.push({
          width,
          status: solved.status,
          model: solved.model ? String(modelValue(solved.model, wide)) : null,
          tier: solved.stats?.routingTier || null,
        });
      }

      // Reused hashes with mutated structured-clone content must fail closed.
      const staleSymbol = createFreshSymbol(bvSort(32), 'browser_stale');
      const staleQuery = makeQuery(
        createCompare(BV_COMPARE_OP.EQ, staleSymbol, createBv(32, 1n)),
        [],
        'browser-stale-query',
      );
      const forged = structuredClone(staleQuery);
      forged.assertion.right.value = 2n;
      const stale = await session.check(forged, { timeoutMs: 2000 });

      const proof = await edgeVerifier.verifyConditionalEdgeFeasibility({
        fromBlock: 'browser-entry',
        toBlock: 'browser-dead',
        edgeCondition: createCompare(BV_COMPARE_OP.EQ, x, createBv(3, 1n)),
        preconditions: createCompare(BV_COMPARE_OP.EQ, x, createBv(3, 2n)),
        backend,
        options: { timeoutMs: 2000 },
      });
      const summary = {
        sat: sat.status,
        satModel: sat.model ? String(modelValue(sat.model, x)) : null,
        unsat: unsat.status,
        wideResults,
        stale: stale.status,
        stalePublishable: stale.lifecycle?.publishable ?? null,
        satBackend: sat.backend,
        unsatBackend: unsat.backend,
        proofVerdict: proof.verdict,
        proofBackend: proof.proofAuthority || null,
        proofAuthority: backend.proofAuthority,
        maxBvWidth: backend.capabilities().maxBvWidth,
        executionIsolation: backend.capabilities().executionIsolation,
        workerAvailable: typeof Worker === 'function',
      };
      await session.dispose();
      return summary;
    });
    if (result.sat !== 'sat' || result.satModel !== '5' || result.unsat !== 'unsat' ||
        result.wideResults?.length !== 2 || result.wideResults.some((item) => item.status !== 'sat' || item.tier !== 'bitblast-qfbv') ||
        result.stale !== 'invalid-query' || result.stalePublishable !== false ||
        result.satBackend !== 'hex-tiered-qfbv-worker' || result.unsatBackend !== 'hex-tiered-qfbv-worker' ||
        result.proofVerdict !== 'proved' || result.proofBackend !== 'exact' ||
        result.proofAuthority !== 'exact' || result.maxBvWidth !== 64 || result.executionIsolation !== 'dedicated-worker' ||
        result.workerAvailable !== true) {
      throw new Error(`${name}: invalid worker runtime result ${JSON.stringify(result)}`);
    }
    console.log(`phase9 browser runtime: ${name} PASS (${JSON.stringify(result)})`);
    return result;
  } finally {
    await context.close();
    await browser.close();
  }
}

export async function runBrowserRuntime() {
  const server = http.createServer(serveSource);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const outcomes = [];
  try {
    const baseUrl = `http://127.0.0.1:${port}/`;
    for (const [name, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
      outcomes.push({ name, status: 'PASSED', result: await checkBrowser(name, browserType, baseUrl) });
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  return Object.freeze(outcomes.map((item) => Object.freeze(item)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  runBrowserRuntime().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
