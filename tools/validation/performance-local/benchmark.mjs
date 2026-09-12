/** Reproducible local speed benchmarks. No network, thresholds or corpus edits. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { sourceManifest } from './source-manifest.mjs';
import { machoBytes, workerClient } from '../../../tests/helpers/performance-worker.mjs';

const root = path.resolve(process.argv[2] || new URL('../../../', import.meta.url).pathname);
const output = process.argv[3];
if (!output) throw new Error('usage: node benchmark.mjs <repository-root> <output.json> [--setup-only]');
const load = (name) => import(pathToFileURL(path.join(root, name)));
const { jsonSafe, stableStringify, stableDigest } = await load('js/core/identity/index.js');
const { createOriginSet, mergeOriginSets } = await load('js/core/identity/origin.js');
const { createSemanticIrFunction } = await load('js/semantics/ir/function.js');
const { canonicalAnalysisIdentity } = await load('js/decompiler/phase8/analysis-identity.js');
const { hashBytes, hashByteSource } = await load('js/platform/hash.js');
const { fingerprintBytes } = await load('js/binary/fingerprint.js');
const { fixture } = await load('tests/phase8/helpers/ir-fixtures.mjs');
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const digest = (value) => createHash('sha256').update(stableStringify(value)).digest('hex');
const results = [];
const setupOnly = process.argv.includes('--setup-only');
async function measure(name, iterations, operation, options = {}) {
  let last;
  const warmupIterations = Math.min(5, iterations);
  for (let i = 0; i < warmupIterations; i++) last = await operation();
  const samplesMs = [];
  for (let repeat = 0; repeat < (setupOnly ? 1 : 7); repeat++) {
    const start = performance.now();
    for (let i = 0; i < (setupOnly ? 1 : iterations); i++) last = await operation();
    samplesMs.push((performance.now() - start) / (setupOnly ? 1 : iterations));
  }
  const result = { name, iterations, warmupIterations, repetitions: samplesMs.length,
    medianMs: median(samplesMs), samplesMs, outputSha256: digest(last), ...options };
  results.push(result);
  console.log(`${name}: ${result.medianMs.toFixed(6)} ms`);
}

const record = Array.from({ length: 160 }, (_, i) => ({ id: `node-${i}`, parent: i % 13,
  source: { file: `源-${i % 11}`, offset: BigInt(i * 16), flags: [true, false, null] },
  values: [i, `value-${i}`, -i, { type: 'bitvector', widthBits: 64 }],
}));
await measure('jsonSafe-record-160', 100, () => jsonSafe(record));
await measure('stableDigest-record-160', 100, () => stableDigest(record));
const origins = Array.from({ length: 32 }, (_, i) => createOriginSet({
  instructionIds: Array.from({ length: 4 }, (_, j) => `instruction_${i}_${j}`),
  byteRanges: [{ binaryId: 'binary_fixture', start: String(i * 16), end: String(i * 16 + 16) }],
  sourceLocations: [{ file: `source-${i % 3}`, line: i }],
}));
await measure('merge-origin-32', 100, () => mergeOriginSets(...origins));
const values = [{ id: 'value_addr', kind: 'entry', machineType: { kind: 'address', widthBits: 64, addressSpace: 'memory' }, sourceEntityId: 'function_fixture', origin: origins[0] }];
const nodes = [];
for (let i = 0; i < 64; i++) {
  const id = `node_load_${i}`, valueId = `value_load_${i}`, origin = origins[i % origins.length];
  values.push({ id: valueId, kind: 'definition', machineType: { kind: 'bitvector', widthBits: 32 }, definitionNodeId: id, sourceEntityId: id, origin });
  nodes.push({ id, kind: 'load', blockId: 'block_entry', inputs: ['value_addr'], outputs: [valueId],
    memory: { addressSpace: 'memory', addressExpr: { valueId: 'value_addr' }, widthBits: 32, endian: 'little', alignment: 4, volatility: false, atomic: false, faults: [] }, sourceEffectIds: [], origin });
}
nodes.push({ id: 'node_return', kind: 'return', blockId: 'block_entry', inputs: ['value_load_63'], outputs: [], origin: origins[0] });
const ir = { schemaVersion: 2, contractVersion: '2.0.0', functionId: 'function_fixture', entryBlockId: 'block_entry',
  blocks: [{ id: 'block_entry', nodeIds: nodes.map((n) => n.id), origin: origins[0] }], nodes, values,
  completeness: 'complete', unknowns: [], origin: mergeOriginSets(...origins) };
await measure('semantic-ir-normalize-65-nodes', 30, () => createSemanticIrFunction(ir));
const f = fixture('performance'); f.block(0);
let previous = f.constant(7n, 32);
for (let i = 0; i < 48; i++) previous = f.binary('add', previous, f.constant(BigInt(i), 32), 32);
f.ret();
const graph = f.build(); graph.origin = ir.origin;
for (const block of graph.blocks) { block.origin = ir.origin; for (const inst of block.insts) inst.origin = ir.origin; }
for (const value of graph.values) value.origin = ir.origin;
await measure('analysis-identity-97-values', 20, () => {
  const result = canonicalAnalysisIdentity({ ir: graph });
  if (!result.valid) throw new Error(result.reason);
  return result;
});
let state = 0x3e719a25;
const bytes = new Uint8Array(8 * 1024 * 1024);
for (let i = 0; i < bytes.length; i++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; bytes[i] = state & 255; }
await measure('hashBytes-4MiB', 3, () => hashBytes(bytes.subarray(0, 4 * 1024 * 1024)), { bytes: 4 * 1024 * 1024 });
await measure('hashByteSource-8MiB', 2, () => hashByteSource(bytes), { bytes: bytes.length });
await measure('fingerprintBytes-4MiB', 3, () => fingerprintBytes(bytes.subarray(0, 4 * 1024 * 1024)), { bytes: 4 * 1024 * 1024 });
const client = await workerClient(pathToFileURL(path.join(root, 'js/platform/worker.js')));
try {
  await client.open(machoBytes(bytes));
  const search = (message) => client.request({ t: 'search', regionId: 'raw', from: 0, ...message });
  const pattern = [...new TextEncoder().encode('speed-pattern-16')];
  await measure('worker-search-hex-16-8MiB', 3, () => search({ kind: 'hex', hex: { bytes: pattern, mask: pattern.map(() => 255) } }), { bytes: bytes.length });
  const mask = pattern.map((_, i) => i % 2 === 0 ? 255 : 15);
  await measure('worker-search-masked-16-8MiB', 3, () => search({ kind: 'hex', hex: { bytes: pattern.map((b, i) => b & mask[i]), mask } }), { bytes: bytes.length });
  await measure('worker-search-text-16-8MiB', 3, () => search({ kind: 'text', query: 'SpEeD-Pattern-16' }), { bytes: bytes.length });
  await measure('worker-search-hex-3-8MiB', 3, () => search({ kind: 'hex', hex: { bytes: [23, 89, 144], mask: [255, 255, 255] } }), { bytes: bytes.length });
  await measure('worker-search-wildcard-cap1000', 10, () => search({ kind: 'hex', hex: { bytes: [0, 0, 0, 0], mask: [0, 0, 0, 0] } }));
  const repeated = new Uint8Array(1024 * 1024).fill(65);
  await client.open(machoBytes(repeated));
  const prefix = [...new Uint8Array(32).fill(65)]; prefix[31] = 66;
  await measure('worker-search-repeated-prefix-32-1MiB', 2, () => search({ kind: 'hex', hex: { bytes: prefix, mask: prefix.map(() => 255) } }), { bytes: repeated.length });
} finally { client.close(); }
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ root, sourceManifest: sourceManifest(root), node: process.version, platform: process.platform, arch: process.arch,
  cpu: os.cpus()[0]?.model, timestamp: new Date().toISOString(), procedure: '7 median samples after explicit warmups; milliseconds per operation; deterministic inputs; no timing thresholds',
  maxRssKiB: process.resourceUsage().maxRSS, results }, null, 2));
