/** Supplementary lifecycle probe; forced GC is diagnostic, never product code. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn } from 'node:timers/promises';
const [rootArg, outputArg, countArg = '3'] = process.argv.slice(2);
const count = Number(countArg);
if (!rootArg || !outputArg || !Number.isSafeInteger(count) || count < 1 || count > 20 || !globalThis.gc) {
  throw new Error('usage: node --expose-gc retention.mjs <repository-root> <output.json> [cycles:1..20]');
}
const root = path.resolve(rootArg), output = path.resolve(outputArg);
const load = relative => import(pathToFileURL(path.join(root, relative)));
const { loadCorpus } = await load('tools/validation/phase8/build-corpus.mjs');
const { decompileEntry, observationOf, closeSessions } = await load('tools/validation/phase8/decompile-corpus.mjs');
const corpus = loadCorpus();
if (corpus.functions.length !== 135) throw new Error('unexpected corpus size');
const replacer = (_key, value) => typeof value === 'bigint' ? { $bigint: value.toString() } : value;
async function reclaimedMemory() {
  // Yield so temporaries from the previous synchronous workflow leave the stack.
  await nextTurn(); globalThis.gc(); await nextTurn(); globalThis.gc();
  return process.memoryUsage();
}
function cycle(index) {
  const hash = createHash('sha256'); let successful = 0, failures = 0;
  const start = performance.now();
  for (const phase8Optimize of [false, true]) {
    for (const architectureId of ['arm64', 'x86_64', 'riscv64']) {
      for (let inputIndex = 0; inputIndex < corpus.functions.length; inputIndex++) {
        const entry = corpus.functions[inputIndex];
        if (entry.architectureId !== architectureId) continue;
        const outcome = decompileEntry(entry, { index: inputIndex, phase8Optimize,
          deterministicTransforms: true, decompilerTimeBudgetMs: 20000 });
        if (outcome.failure) failures++; else successful++;
        hash.update(JSON.stringify({ phase8Optimize, ...observationOf(entry, outcome) }, replacer) + '\n');
        // Do not retain all IRs: one completed result is consumed then released.
      }
    }
  }
  return { index, elapsedMs: performance.now() - start, outputSha256: hash.digest('hex'),
    successful, failures, beforeGc: process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS };
}
const report = { schemaVersion: 1, root, node: process.version, startedAt: new Date().toISOString(),
  scope: 'Three consecutive complete 270-case analysis cycles in ONE process. Modules/decoder sessions stay alive. Results are consumed then released. Explicit GC only measures reclaimable/retained memory; these times are NOT the primary aggregate speed gate or smartphone measurements.',
  afterModuleLoadAndGc: await reclaimedMemory(), cycles: [] };
try {
  for (let i = 1; i <= count; i++) {
    const row = cycle(i); row.afterGc = await reclaimedMemory(); report.cycles.push(row);
    console.log(JSON.stringify(row));
  }
} finally { closeSessions(); }
report.afterSessionCloseAndGc = await reclaimedMemory();
report.maxRssKiB = process.resourceUsage().maxRSS;
report.finishedAt = new Date().toISOString();
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
