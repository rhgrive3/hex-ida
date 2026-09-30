#!/usr/bin/env node
// Blind production evidence collection. This process never opens an oracle.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { openProduct } from '../tools/validation/public-benchmark/product-host.mjs';
import { createCxxEvidenceProvider } from '../js/analysis/cxx/project.js';
import { analyzeFunctionSymbol, isCanonicalCppMemberEvidence } from '../js/analysis/cxx/object-evidence.js';
import { cxxMemberIndexForApp } from '../js/analysis/query/app-adapter.js';
import { openBinary } from '../js/binary/index.js';
import { pinpointField, jevShortlist } from '../js/pinpoint.js';
import { parseGoal } from '../js/goals.js';
import { irFor } from '../js/ir.js';
import { selectSamples } from './validate-pinpoint-cxx-members.mjs';
import { persistentWrite, sha256, verifyCases, snapshotCandidate } from './jev-realgame-final-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUDY = path.join(ROOT, 'reports/investigations/jev-real-game-freeform-holdout');

async function main() {
  const [binaryKey, binaryPath, destination] = process.argv.slice(2);
  if (!binaryKey || !binaryPath || !destination) throw new Error('usage: BINARY_KEY BINARY_PATH OUTPUT');
  const manifest = JSON.parse(fs.readFileSync(path.join(STUDY, 'holdout-manifest.json')));
  const bytes = fs.readFileSync(binaryPath);
  const binarySha256 = sha256(bytes);
  if (manifest.binaries[binaryKey]?.sha256 !== binarySha256) throw new Error('frozen binary hash mismatch');
  const cases = verifyCases(fs.readFileSync(path.join(STUDY, 'holdout-cases.json'))).filter(c => c.binary === binaryKey);
  const policy = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports/investigations/jev-realgame-final/policy-freeze.json')));
  const product = await openProduct(binaryPath);
  if (product.unsupported) throw new Error(product.reason);
  try {
    const image = openBinary(bytes);
    const read = (address, length) => {
      const offset = image.addressToOffset(address);
      return offset == null ? null : bytes.subarray(Number(offset), Number(offset) + length);
    };
    const selector = createCxxEvidenceProvider({ symbols: product.app.symbols, read, pointerBytes: 8,
      architecture: product.architecture, maxClasses: 2500, maxSlots: 128, maxReads: 8192 });
    await selector.build();
    const selection = selectSamples(selector.classEvidence(), product.app, policy.collection.sample, analyzeFunctionSymbol);
    await product.app.ensureObjc(product.sliceIndex);
    const snapshot = await product.query.snapshot();
    const count = () => cxxMemberIndexForApp(product.app)?.fieldCount ?? 0;
    const beforeCount = count();
    const recovered = [];
    const samples = [];
    for (const sample of selection.samples) {
      const start = performance.now();
      const result = await product.query.decompile(snapshot, sample.address, { profile: 'fast' });
      const fn = await product.query.function(snapshot, sample.address, { profile: 'fast', texts: false });
      const projection = fn?.value?.model ? selector.projectForFunction({ functionAddress: sample.address,
        functionName: product.app.symbols.nameAt(sample.address), ir: irFor(fn.value.model) }) : null;
      for (const m of projection?.members ?? []) {
        if (!isCanonicalCppMemberEvidence(m) || !m.accessProven || m.mixedWidths || m.indexed || !m.sizeBytes) continue;
        recovered.push({ binarySha256, className: projection.receiver.classIdentity.className,
          offset: Number(m.offsetBytes), size: m.sizeBytes, conflict: false,
          recoveredType: { category: m.category, proven: m.typeProven },
          functionAddress: String(sample.address), receiverDigest: projection.receiver.digest, memberDigest: m.digest });
      }
      samples.push({ address: String(sample.address), className: sample.className,
        pseudocode: Boolean(result?.value?.pseudocode), recovered: projection?.members.length ?? 0,
        latencyMs: performance.now() - start });
    }
    const index = cxxMemberIndexForApp(product.app);
    const fields = [...(index?.classes.values() ?? [])].flatMap(cls => cls.ivars);
    const rows = [];
    for (const c of cases) {
      const start = performance.now();
      const result = await pinpointField({ goal: parseGoal(c.query), fields: product.app.fields,
        cxxFields: index, limit: 400 });
      const hexLatencyMs = performance.now() - start;
      const candidates = result.candidates.map(cand => snapshotCandidate(cand, product.app.symbols, binarySha256));
      const byKey = new Map(candidates.map(cand => [cand.key, cand]));
      const shortlist = jevShortlist(result.candidates, { max: 255 }).map(cand => byKey.get(cand.key));
      rows.push({ id: c.id, query: c.query, binary: binaryKey, binarySha256,
        verdict: result.verdict, topKey: result.top?.key ?? null,
        universe: result.universe, candidateCount: candidates.length,
        candidates, shortlist, recovered, hexLatencyMs,
        routed: c.mode === 'partial' && candidates.length >= 2 && !['confirmed', 'likely'].includes(result.verdict) });
    }
    const productSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const report = { schema: 'hex-jev-realgame-production-snapshot/v1', productSha,
      collectorSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
      contractSha256: sha256(fs.readFileSync(path.join(ROOT, 'scripts/jev-realgame-final-contract.mjs'))),
      policySha256: sha256(fs.readFileSync(path.join(ROOT, 'reports/investigations/jev-realgame-final/policy-freeze.json'))),
      caseSha256: manifest.caseSha256, binarySha256, binaryKey, architecture: product.architecture,
      collection: { beforeCount, afterCount: fields.length, named: fields.filter(f => !f.anonymous).length,
        unnamed: fields.filter(f => f.anonymous).length, classCount: index?.classCount ?? 0,
        keyCollisions: fields.length - new Set(fields.map(f => f.key)).size,
        selectionTotal: selection.total, samples, profile: product.profile }, rows };
    if (report.collection.keyCollisions || !rows.length || !fields.length) throw new Error('invalid candidate collection');
    persistentWrite(destination, report);
    console.log(JSON.stringify({ productSha, binaryKey, beforeCount, afterCount: fields.length,
      cases: rows.length, samples: samples.length, classCount: index.classCount }));
  } finally { await product.close(); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
