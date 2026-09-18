#!/usr/bin/env node
/** Explicit local transfer. No writes, child processes, network, or providers. */
import { ScopedAnalysisWork } from '../../js/core/budgets/scoped-work.js';
import { processCertificateBundle, CERTIFICATE_BUNDLE_BYTES } from '../../js/core/evidence/certificate-bundle.js';
import { readBoundedJson } from '../lib/bounded-json.mjs';
const [operation, path, ...extra] = process.argv.slice(2);
if (operation === '--help' || !['pack','unpack','replay'].includes(operation) || !path || extra.length) {
  console.log('Usage: node tools/portable-checker/bundle.mjs pack|unpack|replay bundle.json\nPack/unpack are transport only. Replay never qualifies current source or semantic proof.');
  process.exitCode = operation === '--help' ? 0 : 64;
} else {
  const work = new ScopedAnalysisWork({ limits: { deadlineMs: 10000, workUnits: 1000000,
    nodes: 100000, edges: 100000, residentBytes: 128 * 1024 * 1024, calls: 1024 } });
  try {
    const raw = await readBoundedJson(path, { maxBytes: CERTIFICATE_BUNDLE_BYTES, work });
    const result = await processCertificateBundle(operation, raw, { work });
    console.log(JSON.stringify(result));
    process.exitCode = operation !== 'replay' ? 0 : result.counts.rejected ? 2 : 3;
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', reason: String(error?.code ?? error?.message ?? 'bundle-failed').slice(0,256), semanticProof: false }));
    process.exitCode = 1;
  } finally { work.dispose(); }
}
