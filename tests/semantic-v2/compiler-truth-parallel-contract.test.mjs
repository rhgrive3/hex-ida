import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveCompilerTruthConcurrency,
  runCompilerTruthComponents,
} from '../compiler-truth/parallel-components.mjs';

assert.equal(resolveCompilerTruthConcurrency({ env:{ GITHUB_ACTIONS:'true' }, availableParallelism:32 }), 1,
  'hosted CI must keep the historical serial compiler-truth path');
assert.equal(resolveCompilerTruthConcurrency({ env:{}, availableParallelism:1 }), 1);
assert.equal(resolveCompilerTruthConcurrency({ env:{}, availableParallelism:4 }), 3);
assert.equal(resolveCompilerTruthConcurrency({ env:{ HEX_COMPILER_TRUTH_CONCURRENCY:'2' }, availableParallelism:32 }), 2);
assert.equal(resolveCompilerTruthConcurrency({ env:{ HEX_COMPILER_TRUTH_CONCURRENCY:'99' }, availableParallelism:32 }), 3);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-compiler-truth-parallel-contract-'));
try {
  const slow = path.join(root, 'slow.mjs');
  const fast = path.join(root, 'fast.mjs');
  fs.writeFileSync(slow, "await new Promise((resolve) => setTimeout(resolve, 30)); console.log('SLOW');\n");
  fs.writeFileSync(fast, "await new Promise((resolve) => setTimeout(resolve, 2)); console.log('FAST');\n");
  let output = '';
  const result = await runCompilerTruthComponents({
    files:[slow, fast],
    cwd:root,
    env:process.env,
    concurrency:2,
    stdout:{ write(chunk) { output += chunk.toString(); } },
    stderr:{ write() {} },
  });
  assert.equal(result.concurrency, 2);
  assert.equal(result.passed, 2);
  assert.equal(output, 'SLOW\nFAST\n',
    'parallel completion must replay proof output in canonical component order');

  const fail = path.join(root, 'fail.mjs');
  const after = path.join(root, 'after.mjs');
  const marker = path.join(root, 'after.txt');
  fs.writeFileSync(fail, "process.exitCode = 7; console.error('FAIL');\n");
  fs.writeFileSync(after, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  await assert.rejects(runCompilerTruthComponents({
    files:[fail, after],
    cwd:root,
    env:process.env,
    concurrency:2,
    stdout:{ write() {} },
    stderr:{ write() {} },
  }), /1\/2 component\(s\) failed/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran',
    'one failed component must not suppress an independent sibling proof');
} finally {
  fs.rmSync(root, { recursive:true, force:true });
}

console.log('compiler-truth local component scheduling contract: PASS');
