import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBoundedNodeSuite } from '../support/bounded-node-suite.mjs';
import { DECOMPILER_ASSERTION_FILES } from '../support/semantic-corpus-manifest.mjs';

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIRECTORY, '../..');

export async function runDecompilerTests({ env = process.env } = {}) {
  return runBoundedNodeSuite({
    label: 'decompiler',
    files: DECOMPILER_ASSERTION_FILES.map((file) => path.join(ROOT, file)),
    cwd: ROOT,
    env,
    envName: 'HEX_DECOMPILER_TEST_CONCURRENCY',
    maxDefault: 4,
    reserveCores: 0,
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runDecompilerTests().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
