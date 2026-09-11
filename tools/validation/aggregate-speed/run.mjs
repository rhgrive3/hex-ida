/** Fixed sequential application workload; never retune it after optimization. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { sourceManifest } from '../performance-local/source-manifest.mjs';
const [rootArg, outputArg] = process.argv.slice(2);
if (!rootArg || !outputArg) throw new Error('usage: node run.mjs <repository-root> <output.json>');
const root = path.resolve(rootArg), output = path.resolve(outputArg);
const manifestBytes = fs.readFileSync(new URL('./workload.json', import.meta.url));
const plan = JSON.parse(manifestBytes);
const evidenceReplacer = (_key, value) => typeof value === 'bigint' ? { $bigint: value.toString() } : value;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const corpusBytes = fs.readFileSync(path.join(root, 'tests/phase8/corpus/functions.json'));
if (sha256(corpusBytes) !== plan.corpusSha256) throw new Error('corpus identity changed');
const payload = new Uint8Array(plan.payloadBytes);
let rng = plan.seed;
for (let i = 0; i < payload.length; i++) { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; payload[i] = rng & 255; }
// Fixture writing is setup, while reading/importing the resulting file is timed.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-aggregate-speed-'));
const stages = [], outputs = {}, observations = [];
let client, closeSessions;
const productManifest = sourceManifest(root);
const processStarted = performance.now();
async function stage(name, operation) {
  const start = performance.now();
  const value = await operation();
  const elapsedMs = performance.now() - start;
  stages.push({ name, elapsedMs });
  console.log(`${name}: ${elapsedMs.toFixed(3)} ms`);
  return value;
}
const load = (relative) => import(pathToFileURL(path.join(root, relative)));
try {
  const modules = await stage('product-module-initialization', async () => {
    const worker = await load('tests/helpers/performance-worker.mjs');
    const identity = await load('js/core/identity/index.js');
    const hash = await load('js/platform/hash.js');
    const fingerprint = await load('js/binary/fingerprint.js');
    const corpus = await load('tools/validation/phase8/build-corpus.mjs');
    const decompiler = await load('tools/validation/phase8/decompile-corpus.mjs');
    return { ...worker, ...identity, ...hash, ...fingerprint, ...corpus, ...decompiler };
  });
  closeSessions = modules.closeSessions;
  fs.writeFileSync(path.join(temp, 'input.macho'), modules.machoBytes(payload));
  client = await stage('file-read-and-worker-open-8MiB', async () => {
    const bytes = fs.readFileSync(path.join(temp, 'input.macho'));
    const worker = await modules.workerClient(pathToFileURL(path.join(root, 'js/platform/worker.js')));
    await worker.open(bytes); return worker;
  });
  outputs.hash = await stage('resident-byte-hash-8MiB', () => modules.hashBytes(payload));
  outputs.fingerprint = await stage('binary-fingerprint-8MiB', () => modules.fingerprintBytes(payload));
  outputs.sourceHash = await stage('stream-byte-hash-8MiB', () => modules.hashByteSource(payload));
  const pattern = [...new TextEncoder().encode('speed-pattern-16')];
  const mask = pattern.map((_, i) => i % 2 === 0 ? 255 : 15);
  const queries = [
    { kind: 'hex', hex: { bytes: pattern, mask: pattern.map(() => 255) } },
    { kind: 'hex', hex: { bytes: pattern.map((b, i) => b & mask[i]), mask } },
    { kind: 'text', query: 'SpEeD-Pattern-16' },
    { kind: 'hex', hex: { bytes: [23,89,144], mask: [255,255,255] } },
    { kind: 'hex', hex: { bytes: [0,0,0,0], mask: [0,0,0,0] } },
    { kind: 'hex', hex: { bytes: [...new Uint8Array(31).fill(65),66], mask: [...new Uint8Array(32).fill(255)] } },
  ];
  outputs.searches = await stage('six-worker-searches-8MiB', async () => {
    const rows = [];
    for (const query of queries) rows.push(await client.request({ t:'search', regionId:'raw', from:0, ...query }));
    return rows;
  });
  const corpus = modules.loadCorpus();
  if (corpus.functions.length !== 135) throw new Error('unexpected corpus count');
  for (const phase8Optimize of plan.phase8OptimizeModes) {
    for (const arch of plan.architectureOrder) {
      const entries = corpus.functions.map((entry,index) => ({entry,index})).filter(({entry}) => entry.architectureId === arch);
      if (entries.length !== 45) throw new Error('unexpected architecture count');
      const rows = await stage(`decompile-${arch}-45-optimize-${phase8Optimize}`, () => entries.map(({entry,index}) => {
        const outcome = modules.decompileEntry(entry, { index, phase8Optimize,
          deterministicTransforms: plan.deterministicTransforms, decompilerTimeBudgetMs: plan.decompilerTimeBudgetMs });
        return { phase8Optimize, ...modules.observationOf(entry, outcome) };
      }));
      observations.push(...rows);
    }
  }
  outputs.exportDigest = await stage('canonical-report-export-270-results', () => {
    const text = modules.stableStringify({ observations, outputs });
    fs.writeFileSync(path.join(temp, 'report.json'), text);
    // This canonical ID is a product operation, not the independent SHA comparison.
    return modules.stableDigest({ observations, outputs });
  });
  const workloadMs = stages.reduce((total, s) => total + s.elapsedMs, 0);
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), root,
    workloadSha256: sha256(manifestBytes), harnessSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
    sourceCommit: plan.sourceCommit, sourceManifest: productManifest, corpusSha256: plan.corpusSha256, payloadSha256: sha256(payload),
    node: process.version, v8: process.versions.v8, platform: process.platform, arch:process.arch,
    cpu:os.cpus()[0]?.model, stages, workloadMs, processElapsedMs:performance.now()-processStarted,
    maxRssKiB:process.resourceUsage().maxRSS,
    outcomes:{ successful:observations.filter(o=>!o.failure).length, failures:observations.filter(o=>o.failure).length },
    observations, outputs, outputSha256:sha256(JSON.stringify({observations,outputs}, evidenceReplacer)) };
  fs.mkdirSync(path.dirname(output), { recursive:true });
  fs.writeFileSync(output, JSON.stringify(report,evidenceReplacer,2)+'\n');
  console.log(JSON.stringify({workloadMs, outcomes:report.outcomes, outputSha256:report.outputSha256}));
} finally {
  client?.close(); closeSessions?.(); fs.rmSync(temp,{recursive:true,force:true});
}
