#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openProduct } from '../tools/validation/public-benchmark/product-host.mjs';
import { buildCTranslationUnit } from '../js/analysis/query/translation-unit.js';

function opt(args, name, fallback = null) {
  const idx = args.indexOf(name);
  return idx < 0 || idx + 1 >= args.length ? fallback : args[idx + 1];
}

function normalizeErrorBucket(line) {
  const m = line.match(/error:\s*(.+)$/);
  const msg = m ? m[1] : line;
  return msg
    .replace(/'[^']+'/g, "'X'")
    .replace(/\b0x[0-9a-fA-F]+\b/g, '0xN')
    .replace(/\b\d+\b/g, 'N')
    .trim();
}

function compileSource(compiler, tmpDir, src, baseName, timeoutMs = 15000) {
  const cFile = path.join(tmpDir, `${baseName}.c`);
  const oFile = path.join(tmpDir, `${baseName}.o`);
  fs.writeFileSync(cFile, src, 'utf8');
  const errLimitFlag = path.basename(compiler).includes('gcc') ? '-fmax-errors=5' : '-ferror-limit=5';

  const syn = spawnSync(compiler, ['-std=gnu11', '-fsyntax-only', errLimitFlag, cFile], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (syn.error?.code === 'ETIMEDOUT') return { stage: 'syntax', ok: false, timedOut: true, err: 'TIMEOUT' };
  if (syn.error) return { stage: 'syntax', ok: false, timedOut: false, err: String(syn.error.message || syn.error) };
  if (syn.status !== 0) return { stage: 'syntax', ok: false, timedOut: false, err: (syn.stderr || syn.stdout || '').trim() };

  const obj = spawnSync(compiler, ['-std=gnu11', '-O0', errLimitFlag, '-c', cFile, '-o', oFile], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (obj.error?.code === 'ETIMEDOUT') return { stage: 'object', ok: false, timedOut: true, err: 'TIMEOUT' };
  if (obj.error) return { stage: 'object', ok: false, timedOut: false, err: String(obj.error.message || obj.error) };
  if (obj.status !== 0) return { stage: 'object', ok: false, timedOut: false, err: (obj.stderr || obj.stdout || '').trim() };

  return { stage: 'object', ok: true, timedOut: false, err: '' };
}

function collectErrorBuckets(stderr, bucketMap) {
  const lines = stderr.split(/\r?\n/).filter((l) => /error:/.test(l));
  if (lines.length === 0) {
    const first = stderr.split(/\r?\n/)[0] || 'unknown';
    const b = normalizeErrorBucket(first);
    bucketMap.set(b, (bucketMap.get(b) || 0) + 1);
    return { firstLine: first.slice(0, 220), firstBucket: b, errorLines: 0 };
  }
  const firstBucket = normalizeErrorBucket(lines[0]);
  bucketMap.set(firstBucket, (bucketMap.get(firstBucket) || 0) + 1);
  return { firstLine: lines[0].slice(0, 220), firstBucket, errorLines: lines.length };
}

async function runAggregate(args) {
  const inputDir = path.resolve(opt(args, '--input-dir', 'shard-results'));
  const outPath = opt(args, '--out', 'battlecats-recomp-summary.json');
  const files = fs.readdirSync(inputDir, { recursive: true })
    .filter((f) => String(f).endsWith('.json'))
    .map((f) => path.join(inputDir, String(f)))
    .sort();

  const shards = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const totals = {
    shards: shards.length,
    totalDiscovered: shards[0]?.stats?.totalDiscovered || 0,
    sampled: 0,
    decompileOk: 0,
    decompileComplete: 0,
    decompilePartial: 0,
    decompileNull: 0,
    decompileCrash: 0,
    tuEmpty: 0,
    syntaxOnlyStubs: 0,
    faithfulFunctions: 0,
    faithfulPass: 0,
    faithfulFail: 0,
    perFnPass: 0,
    perFnSyntaxFail: 0,
    perFnObjectFail: 0,
    perFnTimeout: 0,
    combinedShardPass: 0,
    combinedShardTotal: 0,
    totalElapsedMs: 0,
  };

  const perFnBuckets = new Map();
  const combinedBuckets = new Map();
  const sampleFailures = [];

  for (const s of shards) {
    const st = s.stats || {};
    for (const k of [
      'sampled', 'decompileOk', 'decompileComplete', 'decompilePartial',
      'decompileNull', 'decompileCrash', 'tuEmpty', 'syntaxOnlyStubs',
      'faithfulFunctions', 'faithfulPass', 'faithfulFail',
      'perFnPass', 'perFnSyntaxFail', 'perFnObjectFail', 'perFnTimeout',
    ]) {
      totals[k] += st[k] || 0;
    }
    totals.totalElapsedMs = Math.max(totals.totalElapsedMs, st.decompileAndCompileMs || 0);
    if (s.combinedResult) {
      totals.combinedShardTotal++;
      if (s.combinedResult.ok) totals.combinedShardPass++;
      for (const [b, c] of s.combinedResult.topBuckets || []) {
        combinedBuckets.set(b, (combinedBuckets.get(b) || 0) + c);
      }
    }
    for (const [b, c] of s.topPerFnErrorBuckets || []) {
      perFnBuckets.set(b, (perFnBuckets.get(b) || 0) + c);
    }
    for (const sf of s.sampleFailures || []) {
      if (sampleFailures.length < 25) sampleFailures.push(sf);
    }
  }

  const passRate = totals.decompileOk > 0
    ? ((totals.perFnPass / totals.decompileOk) * 100).toFixed(2)
    : '0.00';
  const faithfulRate = totals.decompileOk > 0
    ? ((totals.faithfulFunctions / totals.decompileOk) * 100).toFixed(2)
    : '0.00';
  const faithfulCompileRate = totals.faithfulFunctions > 0
    ? ((totals.faithfulPass / totals.faithfulFunctions) * 100).toFixed(2)
    : '0.00';

  const summary = {
    schema: 'battlecats-recomp-bench/v1',
    compiler: shards[0]?.compiler || 'clang',
    headSha: shards[0]?.headSha || null,
    totals,
    passRatePct: Number(passRate),
    faithfulRatePct: Number(faithfulRate),
    faithfulCompileRatePct: Number(faithfulCompileRate),
    topPerFnErrorBuckets: [...perFnBuckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
    topCombinedErrorBuckets: [...combinedBuckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
    sampleFailures,
  };

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  const md = [
    '## BattleCats Recompilation Benchmark (16-way parallel)',
    '',
    `- **Compiler**: \`${summary.compiler}\``,
    `- **Total functions in binary**: ${totals.totalDiscovered}`,
    `- **Sampled across ${totals.shards} shards**: ${totals.sampled}`,
    `- **Decompile OK**: ${totals.decompileOk} (complete=${totals.decompileComplete}, partial=${totals.decompilePartial}, null=${totals.decompileNull}, crash=${totals.decompileCrash})`,
    `- **TranslationUnit faithful vs syntaxOnly**: faithful=${totals.faithfulFunctions} (${faithfulRate}%), syntaxOnlyStubs=${totals.syntaxOnlyStubs}`,
    `- **Per-function compile PASS (all)**: **${totals.perFnPass} / ${totals.decompileOk} (${passRate}%)** (syntaxFail=${totals.perFnSyntaxFail}, objectFail=${totals.perFnObjectFail}, timeout=${totals.perFnTimeout})`,
    `- **Per-function compile PASS (faithful only)**: **${totals.faithfulPass} / ${totals.faithfulFunctions} (${faithfulCompileRate}%)**`,
    `- **Combined-TU shard PASS**: ${totals.combinedShardPass} / ${totals.combinedShardTotal}`,
    `- **Max shard wall-clock**: ${(totals.totalElapsedMs / 1000).toFixed(1)}s`,
    '',
    '### Top Per-Function Compiler Error Buckets',
    '| Count | Error Pattern |',
    '|---:|---|',
    ...summary.topPerFnErrorBuckets.slice(0, 15).map(([b, c]) => `| ${c} | \`${b.replace(/\|/g, '\\|')}\` |`),
  ].join('\n');

  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  }
}

async function runShard(args) {
  const binary = path.resolve(opt(args, '--binary', 'tests/.real-fixtures/battlecats'));
  const shardIdx = Number(opt(args, '--shard-index', '0'));
  const shardTotal = Number(opt(args, '--shard-total', '16'));
  const totalSample = Number(opt(args, '--total-sample', '4000'));
  const compiler = opt(args, '--compiler', 'clang');
  const outPath = opt(args, '--out', `shard-${shardIdx}.json`);

  if (!Number.isInteger(shardIdx) || !Number.isInteger(shardTotal) || shardIdx < 0 || shardIdx >= shardTotal) {
    throw new Error(`Invalid shard: ${shardIdx}/${shardTotal}`);
  }

  const t0 = Date.now();
  const product = await openProduct(binary);
  const tOpen = Date.now() - t0;

  const snapshot = await product.query.snapshot();
  let offset = 0;
  const discovered = [];
  while (true) {
    const page = await product.query.functions(snapshot, {}, { offset, limit: 5000 });
    discovered.push(...(page.value ?? []));
    if (page.page?.next == null) break;
    offset = page.page.next;
  }
  const tDisc = Date.now() - t0 - tOpen;

  discovered.sort((a, b) => {
    const aa = BigInt(a.address);
    const ba = BigInt(b.address);
    return aa < ba ? -1 : aa > ba ? 1 : 0;
  });

  const selectedPool = [];
  if (totalSample > 0 && totalSample < discovered.length) {
    const step = discovered.length / totalSample;
    for (let i = 0; i < totalSample; i++) {
      const idx = Math.min(discovered.length - 1, Math.floor(i * step));
      selectedPool.push(discovered[idx]);
    }
  } else {
    selectedPool.push(...discovered);
  }
  const shardFuncs = selectedPool.filter((_, i) => i % shardTotal === shardIdx);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `bc-shard-${shardIdx}-`));
  const stats = {
    shardIdx,
    shardTotal,
    totalDiscovered: discovered.length,
    sampled: shardFuncs.length,
    openMs: tOpen,
    discoverMs: tDisc,
    decompileOk: 0,
    decompileComplete: 0,
    decompilePartial: 0,
    decompileNull: 0,
    decompileCrash: 0,
    tuEmpty: 0,
    syntaxOnlyStubs: 0,
    faithfulFunctions: 0,
    faithfulPass: 0,
    faithfulFail: 0,
    perFnPass: 0,
    perFnSyntaxFail: 0,
    perFnObjectFail: 0,
    perFnTimeout: 0,
    decompileAndCompileMs: 0,
  };

  const errorBuckets = new Map();
  const sampleFailures = [];
  const decompiledEntries = [];

  const tDecStart = Date.now();
  for (let i = 0; i < shardFuncs.length; i++) {
    const fn = shardFuncs[i];
    let resp;
    try {
      const snap = await product.query.snapshot();
      resp = await product.query.decompile(snap, fn.address, { objcSyntax: 'c' });
    } catch {
      stats.decompileCrash++;
      continue;
    }
    const value = resp?.value;
    const completeness = resp?.status?.completeness ?? resp?.completeness ?? 'unknown';
    const pseudocode = value?.pseudocode ?? value?.code ?? null;
    if (!pseudocode || !pseudocode.trim()) {
      stats.decompileNull++;
      continue;
    }
    stats.decompileOk++;
    if (completeness === 'complete') stats.decompileComplete++;
    else stats.decompilePartial++;

    const entry = {
      address: String(fn.address),
      name: fn.name ?? null,
      end: fn.end == null ? null : String(fn.end),
      pseudocode,
    };
    decompiledEntries.push(entry);

    const unit = buildCTranslationUnit([entry]);
    const src = unit?.source;
    if (!src || !src.trim()) {
      stats.tuEmpty++;
      continue;
    }
    const ufn = unit?.functions?.[0];
    const isFaithful = ufn?.syntaxOnly !== true;
    if (isFaithful) stats.faithfulFunctions++;
    else stats.syntaxOnlyStubs++;

    const res = compileSource(compiler, tmpDir, src, `fn_${i}`);
    if (res.ok) {
      stats.perFnPass++;
      if (isFaithful) stats.faithfulPass++;
    } else if (res.timedOut) {
      stats.perFnTimeout++;
      if (isFaithful) stats.faithfulFail++;
    } else {
      if (isFaithful) stats.faithfulFail++;
      if (res.stage === 'syntax') stats.perFnSyntaxFail++;
      else stats.perFnObjectFail++;
      const cls = collectErrorBuckets(res.err, errorBuckets);
      if (sampleFailures.length < 10) {
        sampleFailures.push({
          addr: entry.address,
          name: entry.name,
          faithful: isFaithful,
          stage: res.stage,
          bucket: cls.firstBucket,
          firstLine: cls.firstLine,
        });
      }
    }
  }
  stats.decompileAndCompileMs = Date.now() - tDecStart;

  let combinedResult = null;
  if (decompiledEntries.length > 0) {
    const tComb = Date.now();
    const unit = buildCTranslationUnit(decompiledEntries);
    const res = compileSource(compiler, tmpDir, unit.source, 'combined_tu', 30000);
    const combBuckets = new Map();
    if (!res.ok) {
      for (const l of res.err.split(/\r?\n/).filter((x) => /error:/.test(x))) {
        const b = normalizeErrorBucket(l);
        combBuckets.set(b, (combBuckets.get(b) || 0) + 1);
      }
    }
    combinedResult = {
      functionsInTu: decompiledEntries.length,
      sourceBytes: unit.source.length,
      ok: res.ok,
      stage: res.stage,
      elapsedMs: Date.now() - tComb,
      topBuckets: [...combBuckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
    };
  }

  await product?.close?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const outObj = {
    compiler,
    headSha: process.env.GITHUB_SHA || null,
    stats,
    topPerFnErrorBuckets: [...errorBuckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
    sampleFailures,
    combinedResult,
  };
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(outObj, null, 2)}\n`, 'utf8');
  console.log(`Shard ${shardIdx}/${shardTotal}: pass=${stats.perFnPass}/${stats.decompileOk}, faithfulPass=${stats.faithfulPass}/${stats.faithfulFunctions}, ms=${stats.decompileAndCompileMs}`);
}

const args = process.argv.slice(2);
if (args.includes('--aggregate')) {
  await runAggregate(args);
} else {
  await runShard(args);
}
