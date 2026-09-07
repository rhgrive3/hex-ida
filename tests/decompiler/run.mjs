import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBoundedNodeSuite } from '../support/bounded-node-suite.mjs';
import {
  DECOMPILER_ASSERTION_FILES,
  phase3SchedulingPriority,
} from '../support/semantic-corpus-manifest.mjs';

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIRECTORY, '../..');

export async function runDecompilerTests({ env = process.env } = {}) {
  // compiler-truth is one leaf of this outer file pool. Keep its own component
  // fanout at one here; standalone `npm run compiler-truth` may still use the
  // local component-level parallel path.
  const childEnv = { ...env, HEX_COMPILER_TRUTH_CONCURRENCY: '1' };
  return runBoundedNodeSuite({
    label: 'decompiler',
    files: DECOMPILER_ASSERTION_FILES.map((file) => path.join(ROOT, file)),
    cwd: ROOT,
    env: childEnv,
    envName: 'HEX_DECOMPILER_TEST_CONCURRENCY',
    // Direct local decompiler:test has no parent pool. Six-way file fanout keeps
    // compiler-truth on the critical path while overlapping the shorter leaves;
    // nested Phase 3 callers explicitly cap this runner to two.
    maxDefault: 6,
    reserveCores: 0,
    priorityForFile: phase3SchedulingPriority,
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runDecompilerTests().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
