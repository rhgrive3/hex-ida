import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBoundedNodeSuite } from '../support/bounded-node-suite.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const CURRENT_CORPUS_FILES = new Set([
  'integration-current-corpus.test.mjs',
  'integration-final-evidence.test.mjs',
  'integration-memory.test.mjs',
  'integration-release-report.test.mjs',
  'integration-zz-current-corpus-gate.test.mjs',
]);
const CURRENT_CORPUS_GROUP = path.join(directory, 'current-corpus-group.mjs');
const RECURSIVE_REGRESSION_FILE = 'integration-required-regression-gates.test.mjs';
const MUTATING_USERSCRIPT_FILE = 'integration-userscript-sync.test.mjs';
const PROJECTION_RUNNER_FILE = 'compat-v1-projection-fidelity-runner.test.mjs';
const PROJECTION_RUNNER_IMPORT = 'repair-v1-projection-fidelity.test.mjs';

export function discoverSemanticV2Tests(rootDirectory = directory) {
  return fs.readdirSync(rootDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map((entry) => path.join(rootDirectory, entry.name))
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

export async function runSemanticV2Tests({ env = process.env, rootDirectory = directory } = {}) {
  const files = discoverSemanticV2Tests(rootDirectory);
  if (!files.length) throw new Error('semantic-v2: no Phase 3 contract tests discovered');

  const dependent = files.filter((file) => CURRENT_CORPUS_FILES.has(path.basename(file)));
  if (dependent.length !== CURRENT_CORPUS_FILES.size) {
    throw new Error(`semantic-v2: evidence dependency group incomplete (${dependent.length}/${CURRENT_CORPUS_FILES.size})`);
  }
  const recursive = files.find((file) => path.basename(file) === RECURSIVE_REGRESSION_FILE);
  const userscript = files.find((file) => path.basename(file) === MUTATING_USERSCRIPT_FILE);
  const projectionRunner = files.find((file) => path.basename(file) === PROJECTION_RUNNER_FILE);
  const projectionImported = files.find((file) => path.basename(file) === PROJECTION_RUNNER_IMPORT);
  if (!recursive || !userscript) throw new Error('semantic-v2: exclusive regression/userscript lane incomplete');
  if (!projectionRunner || !projectionImported) throw new Error('semantic-v2: projection wrapper dependency incomplete');
  const projectionRunnerSource = fs.readFileSync(projectionRunner, 'utf8');
  if (!projectionRunnerSource.includes(`./${PROJECTION_RUNNER_IMPORT}`)) {
    throw new Error(`semantic-v2: ${PROJECTION_RUNNER_FILE} no longer imports ${PROJECTION_RUNNER_IMPORT}`);
  }

  const exclusiveNames = new Set([...CURRENT_CORPUS_FILES, RECURSIVE_REGRESSION_FILE, MUTATING_USERSCRIPT_FILE]);
  // Historical serial execution imported the projection target through the tiny
  // runner first; the later direct import was satisfied by the ESM module cache.
  // In isolated child processes executing both roots would run the same contract
  // twice. Keep the wrapper as the single root so the discovered target still
  // executes exactly once, matching the original semantics and avoiding duplicate work.
  const ordinary = files.filter((file) => !exclusiveNames.has(path.basename(file))
    && path.basename(file) !== PROJECTION_RUNNER_IMPORT);
  const started = process.hrtime.bigint();
  const failures = [];
  let ordinaryResult = null;
  let corpusResult = null;
  let recursiveResult = null;
  let userscriptResult = null;

  // Only independent, repository-read-only files use the bounded pool.
  if (ordinary.length) {
    try {
      ordinaryResult = await runBoundedNodeSuite({
        label: 'semantic-v2',
        files: ordinary,
        cwd: root,
        env,
        envName: 'HEX_SEMANTIC_V2_TEST_CONCURRENCY',
        maxDefault: 4,
        reserveCores: 0,
      });
    } catch (error) {
      failures.push(error);
    }
  }

  // The Phase 3 evidence chain shares globals and recursively executes the locked
  // semantic/decompiler corpus. Keep it in one process, after the ordinary pool
  // drains so those proof subprocesses own the available CPU budget.
  try {
    corpusResult = await runBoundedNodeSuite({
      label: 'semantic-v2-evidence-chain',
      files: [CURRENT_CORPUS_GROUP],
      cwd: root,
      env,
      envName: 'HEX_SEMANTIC_V2_TEST_CONCURRENCY',
      maxDefault: 1,
      reserveCores: 0,
    });
  } catch (error) {
    failures.push(error);
  }

  // These contracts recursively run broad npm suites or temporarily rewrite
  // generated files. They are intentionally exclusive to avoid nested CPU
  // oversubscription and cross-process filesystem races.
  try {
    recursiveResult = await runBoundedNodeSuite({
      label: 'semantic-v2-required-regressions',
      files: [recursive],
      cwd: root,
      env,
      envName: 'HEX_SEMANTIC_V2_TEST_CONCURRENCY',
      maxDefault: 1,
      reserveCores: 0,
    });
  } catch (error) {
    failures.push(error);
  }
  try {
    userscriptResult = await runBoundedNodeSuite({
      label: 'semantic-v2-userscript-sync',
      files: [userscript],
      cwd: root,
      env,
      envName: 'HEX_SEMANTIC_V2_TEST_CONCURRENCY',
      maxDefault: 1,
      reserveCores: 0,
    });
  } catch (error) {
    failures.push(error);
  }

  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (failures.length) {
    throw new AggregateError(failures, `semantic-v2: ${failures.length} execution lane(s) failed`);
  }

  process.stdout.write(`semantic-v2: PASS (${files.length}/${files.length} discovered test files, ${(durationMs / 1000).toFixed(1)}s wall)\n`);
  return Object.freeze({
    passed: files.length,
    failed: 0,
    total: files.length,
    ordinary: ordinaryResult,
    projectionImportedVia: path.basename(projectionRunner),
    evidenceChain: corpusResult,
    requiredRegressions: recursiveResult,
    userscriptSync: userscriptResult,
    durationMs,
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runSemanticV2Tests().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
