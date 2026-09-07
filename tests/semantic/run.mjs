import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBoundedNodeSuite } from '../support/bounded-node-suite.mjs';
import {
  phase3SchedulingPriority,
  SEMANTIC_ASSERTION_FILES,
} from '../support/semantic-corpus-manifest.mjs';

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIRECTORY, '../..');

export const SEMANTIC_TEST_FILES = Object.freeze([
  // Runner behavior is infrastructure coverage, not part of the locked 25-command
  // Phase 3 semantic/decompiler differential denominator.
  'tests/semantic/bounded-node-suite.test.mjs',
  ...SEMANTIC_ASSERTION_FILES,
]);

export async function runSemanticTests({ env = process.env } = {}) {
  return runBoundedNodeSuite({
    label: 'semantic',
    files: SEMANTIC_TEST_FILES.map((file) => path.join(ROOT, file)),
    cwd: ROOT,
    env,
    envName: 'HEX_SEMANTIC_TEST_CONCURRENCY',
    // Direct local semantic:test has no nested suite fanout. Use up to six
    // available cores; nested Phase 3 callers explicitly cap this to two.
    maxDefault: 6,
    reserveCores: 0,
    priorityForFile: phase3SchedulingPriority,
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runSemanticTests().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
