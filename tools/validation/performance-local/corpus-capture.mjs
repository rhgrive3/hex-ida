/** Exact full-field differential capture; independent of timed benchmarks. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGzip } from 'node:zlib';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { sourceManifest, sha256 } from './source-manifest.mjs';
const [rootArg, outputPrefix] = process.argv.slice(2);
if (!rootArg || !outputPrefix) throw new Error('usage: node corpus-capture.mjs <repository-root> <output-prefix>');
const root = path.resolve(rootArg), prefix = path.resolve(outputPrefix);
const load = (file) => import(pathToFileURL(path.join(root, file)));
const { loadCorpus } = await load('tools/validation/phase8/build-corpus.mjs');
const { decompileEntry, observationOf, closeSessions } = await load('tools/validation/phase8/decompile-corpus.mjs');
const { stableStringify } = await load('js/core/identity/index.js');
fs.mkdirSync(path.dirname(prefix), { recursive: true });
const gzip = createGzip(), output = fs.createWriteStream(`${prefix}.jsonl.gz`);
gzip.pipe(output);
// Propagate write failures rather than silently claiming a complete capture.
output.on('error', (error) => gzip.destroy(error));
const metadata = { root, node: process.version, sourceManifest: sourceManifest(root), startedAt: new Date().toISOString() };
const corpus = loadCorpus(), records = [];
for (const phase8Optimize of [false, true]) {
  for (let index = 0; index < corpus.functions.length; index++) {
    const entry = corpus.functions[index];
    const outcome = decompileEntry(entry, { index, deterministicTransforms: false, phase8Optimize });
    const record = { id: entry.id, phase8Optimize, observation: observationOf(entry, outcome) };
    const values = {};
    if (outcome.failure) record.failure = outcome.failure;
    else {
      record.fields = {};
      for (const name of ['semanticAst', 'types', 'evidence', 'phase8', 'pseudocode', 'sourceMap']) {
        const text = stableStringify(outcome.result[name]);
        values[name] = text ?? null;
        record.fields[name] = { present: text !== undefined, bytes: text === undefined ? 0 : Buffer.byteLength(text),
          sha256: text === undefined ? null : sha256(text) };
      }
    }
    records.push(record);
    if (!gzip.write(`${JSON.stringify({ ...record, values })}\n`)) await once(gzip, 'drain');
  }
  console.log(`captured ${corpus.functions.length} inputs, phase8Optimize=${phase8Optimize}`);
}
gzip.end(); await Promise.all([finished(gzip), finished(output)]);
metadata.endedAt = new Date().toISOString();
metadata.maxRssKiB = process.resourceUsage().maxRSS;
fs.writeFileSync(`${prefix}-hashes.json`, JSON.stringify({ metadata, records }, null, 2));
console.log(`captured ${records.length} cases; ${records.filter((r) => !r.failure).length} successes; ${records.filter((r) => r.failure).length} failures`);
closeSessions();
