#!/usr/bin/env node
/*
 * Pass-level profiler for the slowest functions found by the measurement run.
 *
 * Reuses the production PERF-PROBE hooks (`globalThis.__hexPerfProbe`) that
 * already exist in js/decompiler/passes/manager.js and js/core/identity/live-data.js.
 * It never mutates production state; the probe global is only set while the
 * measured decompile call runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProduct } from '../../../../tools/validation/public-benchmark/product-host.mjs';
import { atomicWriteJson, optionValue, readJson, round } from './lib.mjs';

function makeProbe() {
  const passes = [];
  const probe = {
    calls: 0, ms: 0, memoHits: 0, settleRechecks: 0, settleMs: 0,
    obs: new WeakMap(), obsList: [], callers: new Map(),
    capturePassStateMs: 0, capturePassStateCalls: 0, capturePassStateRecords: 0,
    recordPasses(metrics, total) { passes.push({ metrics, total }); },
    recordCapturePassState(ms, records) {
      this.capturePassStateMs += ms; this.capturePassStateCalls += 1; this.capturePassStateRecords += records;
    },
    reset() {
      this.calls = 0; this.ms = 0; this.obs = new WeakMap(); this.obsList = []; this.callers = new Map();
      this.capturePassStateMs = 0; this.capturePassStateCalls = 0; this.capturePassStateRecords = 0; passes.length = 0;
    },
    passes,
  };
  return probe;
}

function probeSummary(probe) {
  const observations = probe.obsList
    .map(record => ({ calls: record.calls, ms: round(record.ms, 2), origin: record.origin ?? null }))
    .sort((left, right) => right.ms - left.ms)
    .slice(0, 5);
  const duplicateCalls = probe.obsList.reduce((total, record) => total + Math.max(0, record.calls - 1), 0);
  const passRun = probe.passes[0] ?? null;
  const phases = (passRun?.metrics ?? []).map(metric => ({
    name: metric.name, ms: round(metric.elapsedMs ?? null, 2), skipped: metric.skipped === true, ok: metric.ok !== false,
  }));
  return {
    decompilePassTotalMs: round(passRun?.total ?? null, 2),
    phases,
    capturePassState: { calls: probe.capturePassStateCalls, ms: round(probe.capturePassStateMs, 2), records: probe.capturePassStateRecords },
    verification: { matchesBodyCalls: probe.calls, matchesBodyMs: round(probe.ms, 2), memoHits: probe.memoHits, settleRechecks: probe.settleRechecks, settleMs: round(probe.settleMs, 2), duplicateCalls, observations },
  };
}

async function profileTargets({ product, target, runs }) {
  const results = [];
  for (let run = 0; run < runs; run++) {
    const probe = makeProbe();
    globalThis.__hexPerfProbe = probe;
    const snapshot = await product.query.snapshot();
    const started = performance.now();
    let status = null;
    try {
      const response = await product.query.decompile(snapshot, target.address);
      status = { completeness: response?.status?.completeness ?? null, reason: response?.status?.reason ?? null };
    } catch (error) {
      status = { completeness: 'CRASH', reason: String(error?.message || error).slice(0, 200) };
    }
    const elapsedMs = performance.now() - started;
    globalThis.__hexPerfProbe = null;
    results.push({ run, elapsedMs: round(elapsedMs, 2), status, ...probeSummary(probe) });
  }
  return results;
}

export async function profileSlowest({ runDir, outPath, topN = 6, runs = 1, log = console.log } = {}) {
  const analysis = readJson(path.join(runDir, 'analysis.json'));
  if (!analysis?.slowest?.length) throw new Error(`profile-slowest-requires-analysis:${runDir}`);
  const byCase = new Map();
  for (const row of analysis.slowest.slice(0, topN)) {
    if (!byCase.has(row.caseId)) byCase.set(row.caseId, []);
    byCase.get(row.caseId).push(row);
  }
  const records = [];
  for (const [caseId, targets] of byCase) {
    const caseRecord = readJson(path.join(runDir, 'cases', `${Buffer.from(caseId).toString('hex')}.json`));
    if (!caseRecord?.binary) continue;
    const product = await openProduct(caseRecord.binary);
    try {
      if (product.unsupported) continue;
      for (const target of targets) {
        const profiled = await profileTargets({ product, target, runs });
        records.push({ caseId, address: target.address, name: target.name, sizeBytes: target.sizeBytes, state: target.state, gotos: target.gotos, profile: profiled });
        log(`${caseId} ${target.name ?? target.address}: ${profiled.map(row => `${row.elapsedMs}ms`).join(', ')}`);
      }
    } finally {
      await product?.close?.();
    }
  }
  const passTotals = new Map();
  for (const record of records) {
    for (const row of record.profile) {
      for (const phase of row.phases ?? []) {
        if (phase.skipped) continue;
        passTotals.set(phase.name, (passTotals.get(phase.name) ?? 0) + (phase.ms ?? 0));
      }
    }
  }
  const summary = {
    schema: 'hex-current-main-profile-slowest/v1',
    runDir, runsPerFunction: runs, denominator: records.length,
    passTotalsMs: Object.fromEntries([...passTotals.entries()].sort((left, right) => right[1] - left[1]).map(([name, ms]) => [name, round(ms, 2)])),
    records,
  };
  atomicWriteJson(outPath, summary);
  log(`profile summary -> ${outPath}`);
  return summary;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const runDir = path.resolve(optionValue(args, '--run', '.'));
  try {
    await profileSlowest({
      runDir,
      outPath: path.resolve(optionValue(args, '--out', path.join(runDir, 'profile-slowest.json'))),
      topN: Number(optionValue(args, '--top', '6')),
      runs: Number(optionValue(args, '--runs', '1')),
    });
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}
