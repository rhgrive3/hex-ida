#!/usr/bin/env node
// CodeFuse-DeBench comparison probe.
//
// Pipeline per case:
//   read-only Hex artifact -> raw function text and product TU variant
//     -> deterministic CodeFuse-fair preprocessing (non-LLM)
//       -> raw recompilability lane (compile/link, finite timeout)
//         -> optional LLM repair lane (external OpenAI-compatible endpoint)
//           -> optional functionality lane (original binary is ground truth)
//
// Nothing here is allowed to silently drop a case or a failed stage: every case
// gets a record with an explicit state for each lane.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { SCHEMA, SOURCE_VARIANTS, UPSTREAM } from './constants.mjs';
import { loadHexManifest, selectProbeCases, indexArtifactsByInputSha, resolveCaseArtifact } from './manifest.mjs';
import { extractHexVariants, sha256 } from './hex-source.mjs';
import { preprocessDecompiledCode } from './codefuse-preprocess.mjs';
import { compileSource, linkBinary, compilerIdentity, validateTimeout, DEFAULT_COMPILE_TIMEOUT_MS } from './compile.mjs';
import { loadLlmConfig, redactedLlmConfig, createLlmClient, probeLlmEndpoint } from './llm-client.mjs';
import { repairSource } from './repair.mjs';
import { runProgram, compareFunctionality, functionalityRate, DEFAULT_RUN_TIMEOUT_MS } from './functionality.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '../../../..');

function slugify(caseId) {
  return String(caseId).replace(/[^A-Za-z0-9._-]+/g, '_');
}

function gitSha(args, cwd) {
  try {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const value = String(result.stdout || '').trim();
    return /^[0-9a-f]{40}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

// A recorded HEAD is only meaningful provenance when the tree it names is the
// tree that produced the artifact. Capture dirtiness before anything is written
// so a probe that ran against uncommitted harness code cannot claim a clean
// commit as its source.
function gitWorktreeDirty(cwd) {
  try {
    const result = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (result.error) return null;
    return String(result.stdout || '').trim().length > 0;
  } catch {
    return null;
  }
}

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// One raw recompilability measurement: compile then link, with bounded
// diagnostics and no full-log retention.
async function rawRecompilability({ sourceFile, cc, ccArgs, workDir, timeoutMs, spawnImpl, rootDir }) {
  // Invoke the toolchain from the repository root with repository-relative
  // paths. Compilers quote the path they are handed, so an absolute invocation
  // would make committed diagnostics - and the discarded-log byte count - depend
  // on how deep the checkout happens to sit.
  const relative = (target) => path.relative(rootDir, target);
  const objectFile = path.join(workDir, `${path.basename(sourceFile)}.o`);
  const binaryFile = path.join(workDir, `${path.basename(sourceFile)}.bin`);
  const compiled = await compileSource({
    file: relative(sourceFile),
    cwd: rootDir,
    cc,
    args: ccArgs,
    objectFile: relative(objectFile),
    timeoutMs,
    spawnImpl,
    rootDir,
  });
  if (!compiled.compileSucceeded) {
    return { status: compiled.status, compileSucceeded: false, linkSucceeded: false, binaryProduced: false, diagnostics: compiled.diagnostics, durationMs: compiled.durationMs, reason: compiled.reason };
  }
  const linked = await linkBinary({
    file: relative(objectFile),
    cwd: rootDir,
    cc,
    args: ccArgs,
    out: relative(binaryFile),
    timeoutMs,
    spawnImpl,
    rootDir,
  });
  return {
    status: linked.linkSucceeded ? 'ok' : linked.status,
    compileSucceeded: true,
    linkSucceeded: linked.linkSucceeded,
    binaryProduced: linked.linkSucceeded,
    // Kept repository-relative; consumers resolve it against the repository root.
    binary: linked.linkSucceeded ? relative(binaryFile) : null,
    diagnostics: linked.diagnostics,
    durationMs: compiled.durationMs + linked.durationMs,
    reason: linked.reason,
  };
}

export async function runProbe({
  repoRoot = DEFAULT_ROOT,
  manifestPath = path.join(repoRoot, 'benchmarks/public/codefuse-arm64/manifest.json'),
  artifactDirectory = path.join(repoRoot, 'reports/public-benchmark'),
  outDir = path.join(repoRoot, 'reports/investigations/codefuse-functionality'),
  count = 5,
  compileTimeoutMs = DEFAULT_COMPILE_TIMEOUT_MS,
  runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
  cc = process.env.CODEFUSE_CC || 'cc',
  ccArgs = [],
  llmConfigPath = process.env.CODEFUSE_LLM_CONFIG || null,
  env = process.env,
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
  writeArtifacts = true,
} = {}) {
  const timeout = validateTimeout(compileTimeoutMs, DEFAULT_COMPILE_TIMEOUT_MS);
  // Provenance is captured before a single artifact is written.
  const worktreeDirtyAtStart = gitWorktreeDirty(repoRoot);
  const manifest = loadHexManifest(manifestPath);
  const artifactIndex = indexArtifactsByInputSha(artifactDirectory);
  const selection = selectProbeCases(manifest.cases, count);

  const workDir = path.join(outDir, '.work');
  const sourcesDir = path.join(outDir, 'per-case/sources');
  if (writeArtifacts) fs.rmSync(workDir, { recursive: true, force: true });

  const llmConfig = loadLlmConfig({ file: llmConfigPath, env });
  // Enabled configuration is not reachability. Prove the endpoint answers within
  // a finite timeout before the repair lane claims to be supported.
  const llmReachability = llmConfig.enabled
    ? await probeLlmEndpoint(llmConfig, { fetchImpl, timeoutMs: 5000 })
    : { reachable: false, reason: llmConfig.disabledReason, status: null };
  const llmActive = llmConfig.enabled && llmReachability.reachable;
  const llmClient = llmActive ? createLlmClient(llmConfig, { fetchImpl }) : null;
  const llmUnavailableReason = llmActive ? null : `llm-endpoint-unavailable:${llmReachability.reason}`;

  const blockers = new Set();
  if (llmUnavailableReason) blockers.add(llmUnavailableReason);
  blockers.add('aarch64-cross-toolchain-not-configured');
  blockers.add('arm64-execution-runtime-not-configured');

  const perCase = [];
  for (const entry of selection.cases) {
    const resolved = resolveCaseArtifact(entry, artifactIndex);
    const record = {
      schema: SCHEMA.case,
      caseId: entry.id,
      binarySha256: entry.binarySha256,
      manifest: { compiler: entry.compiler, optimization: entry.optimization, debug: entry.debug, architecture: entry.architecture },
      artifact: { file: resolved.file ? path.relative(repoRoot, resolved.file) : null, available: resolved.available, reason: resolved.reason },
      variants: {},
      sources: {},
      rawLane: {},
      llmRepairLane: { status: 'unsupported', reason: llmUnavailableReason ?? 'llm-endpoint-unavailable', attempts: 0, history: [] },
      functionality: { raw: { state: 'not-run' }, repaired: { state: 'not-run' } },
      blockers: [],
    };

    if (!resolved.available) {
      record.rawLane.preprocessed = { status: 'artifact_missing', compileSucceeded: false, binaryProduced: false };
      record.rawLane.rawFunctionText = { status: 'artifact_missing', compileSucceeded: false, binaryProduced: false };
      record.blockers.push('artifact-missing');
      perCase.push(record);
      continue;
    }

    const variants = extractHexVariants(resolved.artifact);
    const slug = slugify(entry.id);
    const rawFile = path.join(sourcesDir, `${slug}.${SOURCE_VARIANTS.rawFunctionText}.c`);
    const preFile = path.join(sourcesDir, `${slug}.${SOURCE_VARIANTS.codefusePreprocessed}.c`);
    const prepared = preprocessDecompiledCode(variants.raw.text);

    record.variants = {
      rawFunctionText: { variant: SOURCE_VARIANTS.rawFunctionText, sha256: variants.raw.sha256, bytes: variants.raw.text.length, functions: variants.functionCount, excludedFunctions: variants.excludedCount },
      codefusePreprocessed: { variant: SOURCE_VARIANTS.codefusePreprocessed, sha256: sha256(prepared.code), bytes: prepared.code.length, stats: prepared.stats },
      translationUnit: { variant: SOURCE_VARIANTS.translationUnit, available: variants.translationUnit.available, sha256: variants.translationUnit.sha256, reason: variants.translationUnit.reason },
    };
    record.excludedFunctions = variants.excluded;

    if (writeArtifacts) {
      writeText(rawFile, variants.raw.text);
      writeText(preFile, prepared.code);
      if (variants.translationUnit.available) {
        writeText(path.join(sourcesDir, `${slug}.${SOURCE_VARIANTS.translationUnit}.c`), variants.translationUnit.text);
      }
      record.sources = {
        rawFunctionText: path.relative(repoRoot, rawFile),
        codefusePreprocessed: path.relative(repoRoot, preFile),
        translationUnit: variants.translationUnit.available ? path.relative(repoRoot, path.join(sourcesDir, `${slug}.${SOURCE_VARIANTS.translationUnit}.c`)) : null,
      };
    }

    const caseWorkDir = path.join(workDir, slug);
    if (writeArtifacts) fs.mkdirSync(caseWorkDir, { recursive: true });

    // Raw lane: the CodeFuse-faithful measurement is the preprocessed source
    // with no LLM step. The untouched raw function text is measured separately
    // so the preprocessing effect is never hidden.
    record.rawLane.preprocessed = await rawRecompilability({ sourceFile: preFile, cc, ccArgs, workDir: caseWorkDir, timeoutMs: timeout, spawnImpl, rootDir: repoRoot });
    record.rawLane.preprocessed.input = SOURCE_VARIANTS.codefusePreprocessed;
    record.rawLane.rawFunctionText = await rawRecompilability({ sourceFile: rawFile, cc, ccArgs, workDir: caseWorkDir, timeoutMs: timeout, spawnImpl, rootDir: repoRoot });
    record.rawLane.rawFunctionText.input = SOURCE_VARIANTS.rawFunctionText;

    // Recompilability is a full-success rate (compile AND link).
    record.rawRecompilable = record.rawLane.preprocessed.status === 'ok';

    // LLM repair lane.
    if (llmClient) {
      const check = async (source) => {
        const stageFile = path.join(caseWorkDir, `${slug}.repair.c`);
        fs.writeFileSync(stageFile, source);
        const result = await rawRecompilability({ sourceFile: stageFile, cc, ccArgs, workDir: caseWorkDir, timeoutMs: timeout, spawnImpl, rootDir: repoRoot });
        if (result.status === 'ok') return { status: 'success', phase: 'linker', diagnostics: result.diagnostics };
        return {
          status: result.status === 'compile_failed' ? 'compile_failed' : result.status,
          phase: result.compileSucceeded ? 'linker' : 'compile',
          diagnostics: result.diagnostics,
        };
      };
      const repaired = await repairSource({ source: prepared.code, client: llmClient, check, maxAttempts: llmConfig.maxRepairAttempts });
      record.llmRepairLane = {
        status: repaired.status,
        attempts: repaired.attempts,
        failureReason: repaired.failureReason,
        history: repaired.history,
      };
      if (repaired.status === 'success' && writeArtifacts) {
        const repairedFile = path.join(sourcesDir, `${slug}.${SOURCE_VARIANTS.repaired}.c`);
        writeText(repairedFile, repaired.repairedSource);
        record.sources.repaired = path.relative(repoRoot, repairedFile);
        record.variants.repaired = { variant: SOURCE_VARIANTS.repaired, sha256: sha256(repaired.repairedSource), bytes: repaired.repairedSource.length };
        record.repairedRecompilable = true;
      } else {
        record.repairedRecompilable = false;
      }
    } else {
      record.repairedRecompilable = null;
      record.blockers.push(llmUnavailableReason ?? 'llm-endpoint-unavailable');
    }

    // Functionality lane: only reached when a candidate binary was produced. The
    // ARM64 original is executed only when there is something to compare it
    // against, so a foreign-architecture binary is never run pointlessly.
    const rawBinary = record.rawLane.preprocessed.binaryProduced ? record.rawLane.preprocessed.binary : null;
    if (rawBinary) {
      const originalBinary = path.join(repoRoot, 'benchmarks/public/codefuse-arm64', entry.binary);
      // Both sides run from the repository root so a repository-relative
      // candidate path resolves the same way the original absolute path does.
      const originalRun = await runProgram({ binary: originalBinary, timeoutMs: runTimeoutMs, spawnImpl, cwd: repoRoot });
      const candidateRun = await runProgram({ binary: path.resolve(repoRoot, rawBinary), timeoutMs: runTimeoutMs, spawnImpl, cwd: repoRoot });
      record.functionality.raw = compareFunctionality({ originalRun, candidateRun });
    } else {
      record.functionality.raw = { state: 'unsupported', reason: 'raw-not-recompiled' };
    }
    record.functionality.originalRunIssue = record.functionality.raw.originalRunIssue ?? null;
    record.functionality.repaired = { state: 'unsupported', reason: llmClient ? 'repaired-binary-unavailable' : (llmUnavailableReason ?? 'llm-endpoint-unavailable') };

    record.blockers = [...new Set(record.blockers)];
    for (const blocker of record.blockers) blockers.add(blocker);
    perCase.push(record);
  }

  // Accounting: nothing may be dropped, so every selected case is tallied.
  const states = (pick) => perCase.map(pick);
  const timeoutCount = states((entry) => entry.rawLane?.preprocessed?.status).filter((status) => status === 'timeout').length;
  const summary = {
    schema: SCHEMA.summary,
    generatedAt: new Date().toISOString(),
    upstream: {
      repository: UPSTREAM.repository,
      pinnedCommit: UPSTREAM.pinnedCommit,
      pinnedCommitDate: UPSTREAM.pinnedCommitDate,
      step2States: UPSTREAM.step2States,
      step3ProgramStates: UPSTREAM.step3ProgramStates,
      metricDefinitions: UPSTREAM.published.metricDefinitions,
    },
    identity: {
      headSha: gitSha(['rev-parse', 'HEAD'], repoRoot),
      originMainSha: gitSha(['rev-parse', 'origin/main'], repoRoot),
      worktreeDirty: worktreeDirtyAtStart,
      benchmarkManifest: path.relative(repoRoot, manifestPath),
      benchmarkManifestSha256: sha256(fs.readFileSync(manifestPath, 'utf8')),
      benchmarkCaseTotal: manifest.cases.length,
    },
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      compiler: compilerIdentity(cc),
      measuredArchitecture: process.arch,
      faithfulToUpstreamArchitecture: process.arch === 'arm64',
    },
    llm: { ...redactedLlmConfig(llmConfig), reachable: llmActive, reachabilityReason: llmReachability.reason },
    selection: { count: selection.cases.length, coverage: selection.coverage, caseIds: selection.cases.map((entry) => entry.id) },
    rawRecompilability: {
      input: SOURCE_VARIANTS.codefusePreprocessed,
      denominator: perCase.length,
      passed: perCase.filter((entry) => entry.rawRecompilable === true).length,
      failed: perCase.filter((entry) => entry.rawRecompilable === false).length,
      timeout: timeoutCount,
    },
    rawFunctionTextRecompilability: {
      input: SOURCE_VARIANTS.rawFunctionText,
      passed: perCase.filter((entry) => entry.rawLane?.rawFunctionText?.status === 'ok').length,
      failed: perCase.filter((entry) => entry.rawLane?.rawFunctionText?.status !== 'ok').length,
    },
    repairedRecompilability: {
      supported: llmActive,
      reachability: llmReachability,
      denominator: perCase.length,
      passed: perCase.filter((entry) => entry.repairedRecompilable === true).length,
      failed: perCase.filter((entry) => entry.repairedRecompilable === false).length,
      unsupported: perCase.filter((entry) => entry.repairedRecompilable === null).length,
    },
    rawFunctionality: functionalityRate(perCase.map((entry) => entry.functionality.raw)),
    repairedFunctionality: functionalityRate(perCase.map((entry) => entry.functionality.repaired)),
    counts: {
      selected: perCase.length,
      artifactMissing: perCase.filter((entry) => !entry.artifact.available).length,
      rawTimeout: timeoutCount,
      rawCrashOrFailure: perCase.filter((entry) => ['compile_failed', 'linker_failed'].includes(entry.rawLane?.preprocessed?.status)).length,
      llmUnsupported: perCase.filter((entry) => entry.llmRepairLane.status === 'unsupported').length,
      functionalityUnsupported: perCase.filter((entry) => entry.functionality.raw.state === 'unsupported').length,
    },
    fairness: {
      comparisonClass: llmActive ? 'same benchmark, configured repair model' : 'same benchmark, NO reachable repair model',
      officialNumbersComparable: false,
      note: 'Published IDA/Ghidra recompilability and functionality rates were produced with the upstream LLM/repair/runtime configuration. Raw Hex values must not be presented as the same metric without matching that configuration.',
    },
    blockers: [...blockers].sort(),
    cases: perCase.map((entry) => ({
      caseId: entry.caseId,
      artifactAvailable: entry.artifact.available,
      rawRecompilable: entry.rawRecompilable ?? false,
      rawState: entry.rawLane?.preprocessed?.status ?? 'artifact_missing',
      rawFirstError: entry.rawLane?.preprocessed?.diagnostics?.firstError?.message ?? null,
      llmStatus: entry.llmRepairLane.status,
      rawFunctionality: entry.functionality.raw.state,
      repairedFunctionality: entry.functionality.repaired.state,
      blockers: entry.blockers,
    })),
  };

  if (writeArtifacts) {
    for (const entry of perCase) writeJson(path.join(outDir, 'per-case', `${slugify(entry.caseId)}.json`), entry);
    writeJson(path.join(outDir, 'probe-summary.json'), summary);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  return { summary, perCase };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) { options[key] = true; continue; }
    options[key] = value;
    index += 1;
  }
  return options;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { summary } = await runProbe({
      count: args.count ? Number(args.count) : 5,
      compileTimeoutMs: args['timeout-ms'] ? Number(args['timeout-ms']) : DEFAULT_COMPILE_TIMEOUT_MS,
      outDir: args.out ? path.resolve(args.out) : undefined,
      writeArtifacts: args['dry-run'] !== true,
    });
    console.log(`codefuse probe: ${summary.counts.selected} cases | raw pass ${summary.rawRecompilability.passed}/${summary.rawRecompilability.denominator} | llm ${summary.repairedRecompilability.supported ? 'supported' : 'unsupported'} | blockers: ${summary.blockers.join(', ')}`);
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
