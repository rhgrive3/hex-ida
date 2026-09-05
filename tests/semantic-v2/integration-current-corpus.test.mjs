import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSemanticModel } from '../../js/blocks.js';
import {
  buildIR,
  getLastSemanticV2Instrumentation,
  getSemanticMigrationMode,
  setSemanticMigrationMode,
} from '../../js/ir.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';
import {
  SEMANTIC_ASSERTION_FILES,
  DECOMPILER_ASSERTION_FILES,
  PHASE3_ASSERTION_COMMAND_COUNT,
} from '../support/semantic-corpus-manifest.mjs';
import { runPhase3Corpus } from '../support/phase3-corpus-runner.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const proofPath = ['machine-effects','semantic-ir-v2','scalar-ssa','region-resolver','memoryssa','v1-compat'];

const BASE = 0x100000000n;
const rows = ['mov x20, x19', 'ldr w8, [x20, #0x20]', 'ret'].map((line, row) => {
  const split = line.indexOf(' ');
  return {
    row,
    address: BASE + BigInt(row * 4),
    mn: split < 0 ? line : line.slice(0, split),
    ops: split < 0 ? '' : line.slice(split + 1),
  };
});
const rowOfAddress = (address) => {
  const delta = address - BASE;
  return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
};
const proofModel = buildSemanticModel(rows, { startRow:0, endRow:rows.length - 1, rowOfAddress });
const initialMigrationMode = getSemanticMigrationMode();
setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
const proofIr = buildIR(proofModel, { rowOfAddress });
assert.ok(proofIr, 'explicit v2 public facade must produce a v1 compatibility result');
const proof = getLastSemanticV2Instrumentation();
assert.equal(proof?.v2Executed, true, 'public facade must expose proof that v2 executed');
assert.deepEqual(proof?.path, proofPath);
setSemanticMigrationMode(initialMigrationMode);

const cacheKey = String(process.env.GITHUB_SHA ?? `pid-${process.pid}`).replace(/[^A-Za-z0-9_.-]/g, '_');
const cacheFile = path.join(os.tmpdir(), `hex-phase3-current-corpus-${cacheKey}.json`);
let report = null;
if (process.env.GITHUB_SHA && fs.existsSync(cacheFile)) {
  try {
    const candidate = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const count = Number(candidate?.semantic?.total || 0) + Number(candidate?.decompiler?.total || 0);
    if (count === PHASE3_ASSERTION_COMMAND_COUNT) report = candidate;
  } catch { report = null; }
}

if (!report) {
  const preloadFile = path.join(os.tmpdir(), `hex-phase3-v2-preload-${process.pid}.mjs`);
  const irUrl = pathToFileURL(path.join(root, 'js/ir.js')).href;
  fs.writeFileSync(preloadFile,
    `import { setSemanticMigrationMode } from ${JSON.stringify(irUrl)};\n` +
    `setSemanticMigrationMode('semantic-v2-compat');\n`);
  const preloadUrl = pathToFileURL(preloadFile).href;
  const inheritedNodeOptions = String(process.env.NODE_OPTIONS ?? '').trim();
  const env = {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`,
    NODE_OPTIONS: [inheritedNodeOptions, `--import=${preloadUrl}`].filter(Boolean).join(' '),
  };
  delete env.npm_config_prefix;

  const files = [...SEMANTIC_ASSERTION_FILES, ...DECOMPILER_ASSERTION_FILES];
  const { results, concurrency } = await runPhase3Corpus({
    suite: 'v2-corpus',
    files,
    root,
    env,
    timeoutMs: 600_000,
  });
  const semanticResults = results.slice(0, SEMANTIC_ASSERTION_FILES.length);
  const decompilerResults = results.slice(SEMANTIC_ASSERTION_FILES.length);
  const summarize = (items) => ({
    total: items.length,
    passed: items.filter((result) => result.passed).length,
    failed: items.filter((result) => !result.passed).length,
    results: items,
  });
  report = {
    migrationMode: SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT,
    path: proofPath,
    concurrency,
    semantic: summarize(semanticResults),
    decompiler: summarize(decompilerResults),
  };
  fs.writeFileSync(cacheFile, JSON.stringify(report, null, 2));
  fs.rmSync(preloadFile, { force:true });
}

assert.equal(report.semantic.total + report.decompiler.total, PHASE3_ASSERTION_COMMAND_COUNT,
  'Phase 3 unchanged-assertion command denominator must stay locked at 25');
globalThis.__HEX_PHASE3_CURRENT_CORPUS__ = report;
const corpusSummary = {
  semantic: { total:report.semantic.total, passed:report.semantic.passed, failed:report.semantic.failed },
  decompiler: { total:report.decompiler.total, passed:report.decompiler.passed, failed:report.decompiler.failed },
};
const failedDetails = [
  ...report.semantic.results.filter((result) => !result.passed).map((result) => ({ suite:'semantic', command:result.command, failureTail:result.failureTail ?? '' })),
  ...report.decompiler.results.filter((result) => !result.passed).map((result) => ({ suite:'decompiler', command:result.command, failureTail:result.failureTail ?? '' })),
];
console.log('[phase3-current-corpus]', JSON.stringify(corpusSummary));
console.log(`::warning title=P3_CORPUS::${JSON.stringify({ ...corpusSummary, failedDetails }).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
