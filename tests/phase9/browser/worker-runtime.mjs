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
      const [{ WorkerSolverBackend }, kinds, factory, queryApi, edgeVerifier] = await Promise.all([
        import('/js/symbolic/solver/worker-backend.js'),
        import('/js/symbolic/expr/kinds.js'),
        import('/js/symbolic/expr/factory.js'),
        import('/js/symbolic/verify/query.js'),
        import('/js/symbolic/verify/edge-feasibility.js'),
      ]);
      const { bvSort, BV_BINARY_OP, BV_COMPARE_OP } = kinds;
      const { createBinary, createBv, createCompare, createFreshSymbol } = factory;
      const { CLAIM_KIND, VERIFICATION_QUERY_KIND, createVerificationQuery } = queryApi;
      const backend = new WorkerSolverBackend({ maxBvWidth: 64, exhaustiveMaxAssignments: 1 << 20 });
      const x = createFreshSymbol(bvSort(3), 'browser_x');
      const makeQuery = (values) => createVerificationQuery({
        kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
        claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
        constraints: values.map((value) => createCompare(BV_COMPARE_OP.EQ, x, createBv(3, BigInt(value)))),
      });
      const session = backend.createSession({ timeoutMs: 2000 });
      const sat = await session.check(makeQuery([5]), { timeoutMs: 2000 });
      const unsat = await session.check(makeQuery([1, 2]), { timeoutMs: 2000 });
      const wide = createFreshSymbol(bvSort(64), 'browser_wide');
      const wideSatQuery = createVerificationQuery({
        kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
        claimKind: CLAIM_KIND.EDGE_FEASIBLE,
        constraints: [createCompare(
          BV_COMPARE_OP.EQ,
          createBinary(BV_BINARY_OP.ADD, wide, createBv(64, 1n)),
          createBv(64, 0n),
        )],
      });
      const wideSat = await session.check(wideSatQuery, { timeoutMs: 2000 });
      const forgedWideQuery = structuredClone(wideSatQuery);
      forgedWideQuery.constraints[0].right.value = 1n;
      const forgedHostResult = await session.check(forgedWideQuery, { timeoutMs: 2000 });
      const rawWorker = new Worker(new URL('/js/symbolic/solver/worker-entry.js', location.origin), { type: 'module' });
      const forgedWorkerResult = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('raw forged worker query timed out')), 2000);
        rawWorker.addEventListener('message', (event) => {
          if (event.data?.requestId !== 'forged-structured-clone') return;
          clearTimeout(timer);
          resolve(event.data.result);
        });
        rawWorker.addEventListener('error', reject, { once: true });
        rawWorker.postMessage({
          type: 'solver-check',
          requestId: 'forged-structured-clone',
          token: 77,
          query: forgedWideQuery,
          options: { timeoutMs: 0 },
        });
      });
      rawWorker.terminate();
      const wideUnsat = await session.check(createVerificationQuery({
        kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
        claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
        constraints: [
          createCompare(BV_COMPARE_OP.EQ, wide, createBv(64, 1n)),
          createCompare(BV_COMPARE_OP.EQ, wide, createBv(64, 2n)),
        ],
      }), { timeoutMs: 2000 });
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
        satModel: sat.model ? String(sat.model.browser_x) : null,
        unsat: unsat.status,
        satBackend: sat.backend,
        unsatBackend: unsat.backend,
        wideSat: wideSat.status,
        wideUnsat: wideUnsat.status,
        wideRoute: wideSat.stats.routingTier,
        forgedHost: forgedHostResult.status,
        forgedHostHash: forgedHostResult.queryHash,
        forgedWorker: forgedWorkerResult.status,
        forgedWorkerHash: forgedWorkerResult.queryHash,
        proofVerdict: proof.verdict,
        proofBackend: proof.proofAuthority || null,
        proofAuthority: backend.proofAuthority,
        executionIsolation: backend.capabilities().executionIsolation,
        workerAvailable: typeof Worker === 'function',
      };
      await session.dispose();
      return summary;
    });
    if (result.sat !== 'sat' || result.satModel !== '5' || result.unsat !== 'unsat' ||
        result.satBackend !== 'hex-tiered-qfbv-worker' || result.unsatBackend !== 'hex-tiered-qfbv-worker' ||
        result.wideSat !== 'sat' || result.wideUnsat !== 'unsat' || result.wideRoute !== 'bitblast-qfbv' ||
        result.forgedHost !== 'invalid-query' || result.forgedHostHash !== null ||
        result.forgedWorker !== 'invalid-query' || result.forgedWorkerHash !== null ||
        result.proofVerdict !== 'proved' || result.proofBackend !== 'exact' ||
        result.proofAuthority !== 'exact' || result.executionIsolation !== 'dedicated-worker' ||
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
      try {
        outcomes.push({ name, status: 'PASSED', result: await checkBrowser(name, browserType, baseUrl), error: null });
      } catch (error) {
        outcomes.push({ name, status: 'FAILED', result: null, error: String(error?.message || error) });
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  return Object.freeze(outcomes.map((item) => Object.freeze(item)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  runBrowserRuntime().then((outcomes) => {
    const failed = outcomes.filter((item) => item.status !== 'PASSED');
    if (failed.length) throw new Error(failed.map((item) => `${item.name}: ${item.error}`).join('\n'));
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
