import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverPhaseTests, runPhaseNodeTests } from '../support/phase-node-test-runner.mjs';

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

/**
 * Canonical Phase 11 managed-frontends test runner.
 *
 * #8759: this runner used to `await import()` each discovered `.test.mjs` file and
 * count the import itself as a pass, so a suite with real `node:test` assertion
 * failures still reported `0 failed` (false green). It now delegates to the shared
 * phase runner contract (`tests/support/phase-node-test-runner.mjs`) — the same
 * outcome authority used by Phases 8–10 — so exit status and the programmatic
 * result reflect actual test outcomes, and `runPhase11Tests` never resolves while
 * any selected test fails.
 */
export function findTests(dir = DIRECTORY) {
  return discoverPhaseTests(dir);
}

export async function runPhase11Tests(argv = [], { root = DIRECTORY } = {}) {
  // Same isolation tests/support/phase-runner consumers apply: a parent
  // `node --test` harness exports NODE_TEST_CONTEXT, and a nested runner that
  // inherits it reports success instead of real outcomes. The Phase 11 runner
  // must therefore never propagate its own harness context into the spawn.
  const { NODE_TEST_CONTEXT: _omitted, ...env } = process.env;
  return runPhaseNodeTests({ phase: 'phase11', root, argv, env, parallel: true });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await runPhase11Tests(process.argv.slice(2));
  } catch {
    process.exit(1);
  }
}
