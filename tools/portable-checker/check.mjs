#!/usr/bin/env node
/** Explicit local-file replay; no packages, shell commands or remote providers. */
import { readBoundedJson } from '../lib/bounded-json.mjs';
import { ScopedAnalysisWork } from '../../js/core/budgets/scoped-work.js';
import { replayPortableChecks, PORTABLE_CHECK_LIMITS } from '../../js/core/evidence/portable-replay.js';
const args = process.argv.slice(2);
if (args.length !== 1 || args[0] === '--help') {
  console.log('Usage: node tools/portable-checker/check.mjs capsule.json\nDetached checks only; current source binding and whole-query proof remain unverified.');
  process.exitCode = args[0] === '--help' ? 0 : 64;
} else {
  const work = new ScopedAnalysisWork({ limits: { deadlineMs: 5000, workUnits: 100000, residentBytes: 4194304 } });
  try {
    const input = await readBoundedJson(args[0], { maxBytes: PORTABLE_CHECK_LIMITS.encodedBytes, work });
    const result = await replayPortableChecks(input, { work });
    console.log(JSON.stringify(result));
    process.exitCode = result.counts.rejected ? 2 : result.allListedDerivationsChecked ? 0 : 3;
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', reason: String(error?.code ?? error?.message ?? 'portable-check-failed').slice(0, 256), semanticProof: false }));
    process.exitCode = 1;
  } finally { work.dispose(); }
}
