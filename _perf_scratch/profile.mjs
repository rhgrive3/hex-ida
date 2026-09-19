import { openProduct } from '../tools/validation/public-benchmark/product-host.mjs';

const binary = process.argv[2];
const address = BigInt(process.argv[3] || '6328');
const runs = Number(process.argv[4] || 3);
const mode = process.argv[5] || 'time'; // time | stacks
const addressId = `0x${address.toString(16)}`;
const j = (v) => JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? `0x${x.toString(16)}` : x);

function makeProbe(stacks) {
  const passes = [];
  const probe = {
    calls: 0, ms: 0, memoHits: 0, settleRechecks: 0, settleMs: 0, obs: new WeakMap(), obsList: [],
    stacks, callers: new Map(),
    capturePassStateMs: 0, capturePassStateCalls: 0, capturePassStateRecords: 0,
    recordPasses(metrics, total) { passes.push({ metrics, total }); },
    recordCapturePassState(ms, records) { this.capturePassStateMs += ms; this.capturePassStateCalls++; this.capturePassStateRecords += records; },
    reset() { this.calls = 0; this.ms = 0; this.obs = new WeakMap(); this.obsList = []; this.callers = new Map(); this.capturePassStateMs = 0; this.capturePassStateCalls = 0; this.capturePassStateRecords = 0; passes.length = 0; },
    passes,
  };
  return probe;
}

const product = await openProduct(binary);
if (product.unsupported) { console.log('UNSUPPORTED', product.reason); process.exit(2); }
const snapshot = await product.query.snapshot();
let offset = 0;
const discovered = [];
while (true) {
  const page = await product.query.functions(snapshot, {}, { offset, limit: 1000 });
  discovered.push(...(page.value ?? []));
  if (page.page?.next == null) break;
  offset = page.page.next;
}
const fn = discovered.find(f => `0x${BigInt(f.address).toString(16)}` === addressId);
console.log('function:', j(fn));

const results = [];
for (let i = 0; i < runs; i++) {
  const probe = makeProbe(mode === 'stacks');
  globalThis.__hexPerfProbe = probe;
  const current = await product.query.snapshot();
  const t0 = performance.now();
  const response = await product.query.decompile(current, addressId);
  const t1 = performance.now();
  globalThis.__hexPerfProbe = null;
  // aggregate per-observation calls
  const obsList = probe.obsList;
  const distinctObs = obsList.length;
  const dupCalls = obsList.reduce((acc, rec) => acc + Math.max(0, rec.calls - 1), 0);
  const multiObs = obsList.filter(rec => rec.calls > 1).length;
  const obsTop = obsList.slice().sort((a, b) => b.ms - a.ms).slice(0, 4).map(rec => ({ calls: rec.calls, ms: +rec.ms.toFixed(2), trueCount: rec.trueCount, falseCount: rec.falseCount, origin: rec.origin, topCallers: rec.callers ? [...rec.callers.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5) : undefined }));
  const passes = probe.passes.map(p => ({ total: p.total, phases: p.metrics.map(m => ({ name: m.name, ms: m.elapsedMs, skipped: !!m.skipped, ok: m.ok })) }));
  const topCallers = [...probe.callers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  results.push({
    run: i, decompileMs: t1 - t0,
    matchesBodyCalls: probe.calls, matchesMs: probe.ms, memoHits: probe.memoHits, settleRechecks: probe.settleRechecks, settleMs: +probe.settleMs.toFixed(1), distinctObs, dupCalls, multiObs, obsTop,
    capturePassStateCalls: probe.capturePassStateCalls, capturePassStateMs: probe.capturePassStateMs,
    passTotalMs: passes[0]?.total ?? null,
    passes: passes[0]?.phases ?? null,
    topCallers: mode === 'stacks' ? topCallers : undefined,
  });
}

console.log('RESULTS');
for (const r of results) {
  console.log(j({ run: r.run, decompileMs: +r.decompileMs.toFixed(1), matchesBodyCalls: r.matchesBodyCalls, memoHits: r.memoHits, settleRechecks: r.settleRechecks, settleMs: r.settleMs, matchesMs: +r.matchesMs.toFixed(1), distinctObs: r.distinctObs, dupCalls: r.dupCalls, multiObs: r.multiObs, capturePassStateCalls: r.capturePassStateCalls, capturePassStateMs: +r.capturePassStateMs.toFixed(1), passTotalMs: +(r.passTotalMs ?? 0).toFixed(1) }));
  if (r.obsTop) console.log('  obsTop:', j(r.obsTop));
}
if (results[0]?.passes) {
  console.log('PASSES run0:');
  for (const p of results[0].passes) console.log(j(p));
}
if (results[0]?.topCallers) {
  console.log('TOP CALLERS run0:');
  for (const [frame, count] of results[0].topCallers) console.log(count, frame);
}
await product.close();
