#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProduct } from './product-host.mjs';
import { percentile } from './fresh-state.mjs';

function optionValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}

export async function profileBinary(binary, { functionLimit = 0, functionTimeoutMs = 30000 } = {}) {
  const started = performance.now();
  const product = await openProduct(binary);
  try {
    if (product.unsupported) return { binary, state:'UNSUPPORTED', reason:product.reason, setup:product.profile ?? {}, totalMs:performance.now() - started };
    const snapshotStarted = performance.now();
    const snapshot = await product.query.snapshot();
    let offset = 0;
    const discovered = [];
    while (true) {
      const page = await product.query.functions(snapshot, {}, { offset, limit:1000 });
      discovered.push(...(page.value ?? []));
      if (page.page?.next == null) break;
      offset = page.page.next;
    }
    const discoveryQueryMs = performance.now() - snapshotStarted;
    const selected = functionLimit > 0 ? discovered.slice(0, functionLimit) : discovered;
    const functions = [];
    for (const fn of selected) {
      const controller = new AbortController();
      const error = new Error('profile-function-timeout'); error.name = 'AbortError';
      const timer = setTimeout(() => controller.abort(error), functionTimeoutMs);
      const fnStarted = performance.now();
      try {
        const current = await product.query.snapshot({ signal:controller.signal });
        const response = await product.query.decompile(current, fn.address, { signal:controller.signal });
        functions.push({ address:String(fn.address), name:fn.name ?? null, elapsedMs:performance.now() - fnStarted, state:response?.value ? (response?.status?.completeness === 'complete' ? 'PASS' : String(response?.status?.completeness ?? 'UNKNOWN').toUpperCase()) : 'UNSUPPORTED' });
      } catch (caught) {
        functions.push({ address:String(fn.address), name:fn.name ?? null, elapsedMs:performance.now() - fnStarted, state:caught?.name === 'AbortError' ? 'TIMEOUT' : 'CRASH', reason:String(caught?.message || caught) });
      } finally { clearTimeout(timer); }
    }
    const times = functions.map(row=>row.elapsedMs);
    return {
      binary,
      state:'PASS',
      inputSha256:product.sha,
      architecture:product.architecture,
      endianness:product.endianness,
      setup:product.profile ?? {},
      discoveryQueryMs,
      functionCount:discovered.length,
      measuredFunctionCount:selected.length,
      functions,
      functionTiming:{ p50Ms:percentile(times,50), p90Ms:percentile(times,90), maxMs:times.length ? Math.max(...times) : null, totalMs:times.reduce((a,b)=>a+b,0) },
      totalMs:performance.now() - started,
    };
  } finally { await product?.close?.(); }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const binaries = args.filter(value => !value.startsWith('--') && !/^\d+$/.test(value));
  const functionLimit = Number(optionValue(args,'--functions','0'));
  const functionTimeoutMs = Number(optionValue(args,'--function-timeout-ms','30000'));
  if (!binaries.length) {
    console.error('usage: node profile-fresh.mjs <binary> [binary...] [--functions N] [--function-timeout-ms MS]');
    process.exitCode = 2;
  } else {
    const rows=[];
    for (const binary of binaries) rows.push(await profileBinary(binary,{functionLimit,functionTimeoutMs}));
    console.log(JSON.stringify({ schema:'hex-public-benchmark-fresh-profile/v1', rows },null,2));
  }
}
