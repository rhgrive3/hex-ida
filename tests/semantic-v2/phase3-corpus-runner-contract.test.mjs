import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DECOMPILER_ASSERTION_COMMANDS,
  DECOMPILER_ASSERTION_FILES,
  PHASE3_ASSERTION_COMMAND_COUNT,
  SEMANTIC_ASSERTION_COMMANDS,
  SEMANTIC_ASSERTION_FILES,
} from '../support/semantic-corpus-manifest.mjs';
import {
  phase3CorpusReuseKey,
  runPhase3Corpus,
} from '../support/phase3-corpus-runner.mjs';

assert.equal(SEMANTIC_ASSERTION_FILES.length, 11);
assert.equal(DECOMPILER_ASSERTION_FILES.length, 14);
assert.equal(PHASE3_ASSERTION_COMMAND_COUNT, 25);
const allFiles = [...SEMANTIC_ASSERTION_FILES, ...DECOMPILER_ASSERTION_FILES];
assert.equal(new Set(allFiles).size, 25, 'Phase 3 assertion corpus must contain 25 unique entrypoints');
assert.deepEqual(SEMANTIC_ASSERTION_COMMANDS, SEMANTIC_ASSERTION_FILES.map((file) => `node ${file}`));
assert.deepEqual(DECOMPILER_ASSERTION_COMMANDS, DECOMPILER_ASSERTION_FILES.map((file) => `node ${file}`));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-phase3-runner-contract-'));
try {
  fs.writeFileSync(path.join(root, 'a.mjs'), 'process.exitCode = 0;\n');
  fs.writeFileSync(path.join(root, 'b.mjs'), 'process.exitCode = 7;\n');
  fs.writeFileSync(path.join(root, 'c.mjs'), 'process.exitCode = 0;\n');
  const { results, concurrency } = await runPhase3Corpus({
    suite: 'contract',
    files: ['a.mjs', 'b.mjs', 'c.mjs'],
    root,
    env: { ...process.env, HEX_PHASE3_CORPUS_CONCURRENCY: '2' },
    timeoutMs: 10_000,
    availableParallelism: 2,
  });
  assert.equal(concurrency, 2);
  assert.deepEqual(results.map((result) => result.command), ['node a.mjs', 'node b.mjs', 'node c.mjs'],
    'parallel completion order must not change canonical evidence order');
  assert.deepEqual(results.map((result) => result.passed), [true, false, true],
    'one failure must not prevent later corpus commands from executing');

  const countFile = path.join(root, 'count.txt');
  fs.writeFileSync(path.join(root, 'count.mjs'),
    "import fs from 'node:fs'; fs.appendFileSync(process.env.PHASE3_COUNT_FILE, 'x\\n');\n");
  const reuseEnv = {
    ...process.env,
    HEX_PHASE3_CORPUS_CONCURRENCY: '1',
    HEX_PHASE3_INPROCESS_REUSE_TOKEN: 'contract-reuse-token',
    PHASE3_COUNT_FILE: countFile,
  };
  const baseKey = phase3CorpusReuseKey({
    suite:'reuse-contract', files:['count.mjs'], root, env:reuseEnv,
    timeoutMs:10_000, envName:'HEX_PHASE3_CORPUS_CONCURRENCY', concurrency:1,
  });
  assert.equal(typeof baseKey, 'string');
  assert.equal(phase3CorpusReuseKey({
    suite:'reuse-contract', files:['count.mjs'], root,
    env:{ ...reuseEnv, HEX_PHASE3_INPROCESS_REUSE_TOKEN:'' },
    timeoutMs:10_000, envName:'HEX_PHASE3_CORPUS_CONCURRENCY', concurrency:1,
  }), null, 'reuse must be impossible without an explicit process-scoped token');
  assert.notEqual(baseKey, phase3CorpusReuseKey({
    suite:'reuse-contract', files:['count.mjs'], root,
    env:{ ...reuseEnv, PHASE3_REUSE_VARIANT:'changed' },
    timeoutMs:10_000, envName:'HEX_PHASE3_CORPUS_CONCURRENCY', concurrency:1,
  }), 'environment drift must invalidate in-process proof reuse');

  await runPhase3Corpus({
    suite:'reuse-contract', files:['count.mjs'], root, env:reuseEnv,
    timeoutMs:10_000, availableParallelism:1,
  });
  await runPhase3Corpus({
    suite:'reuse-contract', files:['count.mjs'], root, env:reuseEnv,
    timeoutMs:10_000, availableParallelism:1,
  });
  assert.equal(fs.readFileSync(countFile, 'utf8').trim().split(/\n/).length, 1,
    'an exact token-bound duplicate must execute once inside the same process');

  await runPhase3Corpus({
    suite:'reuse-contract', files:['count.mjs'], root,
    env:{ ...reuseEnv, PHASE3_REUSE_VARIANT:'changed' },
    timeoutMs:10_000, availableParallelism:1,
  });
  assert.equal(fs.readFileSync(countFile, 'utf8').trim().split(/\n/).length, 2,
    'environment drift must force fresh proof execution');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
