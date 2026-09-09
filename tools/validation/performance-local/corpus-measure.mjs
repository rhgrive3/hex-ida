/** Runs this snapshot's UNMODIFIED canonical performance procedure. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { sourceManifest, sha256 } from './source-manifest.mjs';
const [rootArg, output] = process.argv.slice(2);
if (!rootArg || !output) throw new Error('usage: node corpus-measure.mjs <repository-root> <output.json>');
const root = path.resolve(rootArg);
const load = (file) => import(pathToFileURL(path.join(root, file)));
const { loadCorpus } = await load('tools/validation/phase8/build-corpus.mjs');
const { performanceMetrics } = await load('tools/validation/phase8/metrics.mjs');
const { closeSessions } = await load('tools/validation/phase8/decompile-corpus.mjs');
const profile = JSON.parse(fs.readFileSync(path.join(root, 'tools/validation/phase8/profile.json')));
const corpus = loadCorpus();
const metadata = { root, node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch,
  cpu: os.cpus()[0]?.model, sourceManifest: sourceManifest(root),
  corpusSha256: sha256(fs.readFileSync(path.join(root, 'tests/phase8/corpus/functions.json'))),
  profileSha256: sha256(fs.readFileSync(path.join(root, 'tools/validation/phase8/profile.json'))),
  canonicalApi: 'tools/validation/phase8/metrics.mjs:performanceMetrics', startedAt: new Date().toISOString() };
console.log(`START ${root}: ${corpus.functions.length} inputs, ${profile.performance.repetitions} repetitions`);
const started = performance.now();
const result = performanceMetrics({ repetitions: profile.performance.repetitions, corpus });
metadata.elapsedMs = performance.now() - started;
metadata.endedAt = new Date().toISOString();
metadata.maxRssKiB = process.resourceUsage().maxRSS;
const summaries = result.runs.map((run) => ({ inputs: run.length, successful: run.filter((o) => !o.failure).length,
  failures: run.filter((o) => o.failure).map(({ id, failure }) => ({ id, failure })),
  semantic: run.filter((o) => o.semantic).length,
  publishedLedgers: run.filter((o) => o.phase8?.published).length }));
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ metadata, profile, result, summaries }, null, 2));
console.log(JSON.stringify({ coldActiveFunctionMs: result.coldActiveFunctionMs, elapsedMs: metadata.elapsedMs,
  maxRssKiB: metadata.maxRssKiB, runs: summaries.map(({ failures, ...rest }) => ({ ...rest, failures: failures.length })) }, null, 2));
closeSessions();
