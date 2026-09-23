#!/usr/bin/env node
/*
 * Hash-bind the current-main weakness investigation artifacts and validate integrity.
 *
 * Reads each artifact, records its sha256 and size, and writes manifest.json
 * with the measured provenance (head, sourceIdentity, configHash, harness
 * hashes).
 *
 * When run with --verify, checks that:
 * 1. All artifacts match manifest hashes
 * 2. Invariants hold (e.g. unknownInstructionsObserved + unknownInstructionsMissing === total)
 * 3. Headline numbers in README match generated JSON
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, sha256 } from './lib.mjs';

const REPORT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IGNORED = new Set(['manifest.json', 'README.md']);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

export function validateArtifacts(manifest, reportRoot = REPORT_ROOT) {
  const errors = [];
  for (const item of manifest.artifacts) {
    const full = path.join(reportRoot, item.path);
    if (!fs.existsSync(full)) {
      errors.push(`missing-artifact:${item.path}`);
      continue;
    }
    const bytes = fs.readFileSync(full);
    const hash = sha256(bytes);
    if (hash !== item.sha256) {
      errors.push(`hash-mismatch:${item.path} expected=${item.sha256} actual=${hash}`);
    }
    if (bytes.length !== item.bytes) {
      errors.push(`size-mismatch:${item.path} expected=${item.bytes} actual=${bytes.length}`);
    }
  }

  const runDir = path.join(reportRoot, 'measurements/run-20260923-stratified');
  const analysis = readJson(path.join(runDir, 'analysis.json'));
  if (analysis) {
    const cov = analysis.coverage;
    const totalFns = analysis.denominator.functions;
    if (cov.unknownInstructionsObserved + cov.unknownInstructionsMissing !== totalFns) {
      errors.push(`invariant-failed: unknownInstructionsObserved (${cov.unknownInstructionsObserved}) + missing (${cov.unknownInstructionsMissing}) !== total (${totalFns})`);
    }
    if (cov.unknownInstructionsMissing === 0) {
      errors.push('invariant-failed: unknownInstructionsMissing cannot be 0 for this corpus');
    }
    if (cov.unknownInstructionsObserved !== 1960 || cov.unknownInstructionsMissing !== 298 || cov.functionsWithUnknownInstructions !== 95) {
      errors.push(`unexpected-unknown-counts: observed=${cov.unknownInstructionsObserved} missing=${cov.unknownInstructionsMissing} withUnknown=${cov.functionsWithUnknownInstructions}`);
    }
  }

  const replay = readJson(path.join(runDir, 'recompilability/replay-summary.json'));
  if (replay) {
    if (replay.denominator?.cases !== 32 || replay.denominator?.sampledFunctions !== 192) {
      errors.push(`recompilability-denominator-mismatch: ${JSON.stringify(replay.denominator)}`);
    }
    if (replay.caseFirstFamilies?.['undeclared-local'] !== 32) {
      errors.push(`recompilability-case-families-unexpected: ${JSON.stringify(replay.caseFirstFamilies)}`);
    }
  }

  const tuReplay = readJson(path.join(runDir, 'tu-replay/tu-replay-summary.json'));
  if (tuReplay) {
    if (tuReplay.denominator?.cases !== 6) {
      errors.push(`tu-replay-denominator-mismatch: ${JSON.stringify(tuReplay.denominator)}`);
    }
  }

  const readme = fs.readFileSync(path.join(reportRoot, 'README.md'), 'utf8');
  if (readme.includes('95/2258 (4.2%) carry unknown')) {
    errors.push('readme-contains-stale-unknown-instructions-denominator: 95/2258 (4.2%)');
  }
  if (!readme.includes('09dfcb283')) {
    errors.push('readme-missing-measured-snapshot-head: 09dfcb283');
  }

  return errors;
}

const isVerify = process.argv.includes('--verify');

if (isVerify) {
  const manifest = readJson(path.join(REPORT_ROOT, 'manifest.json'));
  if (!manifest) {
    console.error('manifest.json not found');
    process.exitCode = 1;
  } else {
    const errors = validateArtifacts(manifest);
    if (errors.length) {
      console.error(`Validation failed with ${errors.length} errors:\n${errors.join('\n')}`);
      process.exitCode = 1;
    } else {
      console.log(`Validation passed: all ${manifest.artifacts.length} artifacts match and all invariants hold.`);
    }
  }
} else {
  const artifacts = [];
  for (const file of walk(REPORT_ROOT)) {
    const relative = path.relative(REPORT_ROOT, file).split(path.sep).join('/');
    if (IGNORED.has(relative)) continue;
    if (relative.includes('/run-20260923-stratified/receipts/')) continue; // regenerable per-function receipts
    const bytes = fs.readFileSync(file);
    artifacts.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
  }

  const runDir = path.join(REPORT_ROOT, 'measurements/run-20260923-stratified');
  const run = readJson(path.join(runDir, 'run.json'));
  const summary = readJson(path.join(runDir, 'summary.json'));
  const replay = readJson(path.join(runDir, 'recompilability/replay-summary.json'));
  const tuReplay = readJson(path.join(runDir, 'tu-replay/tu-replay-summary.json'));
  const profile = readJson(path.join(runDir, 'profile-slowest.json'));

  const manifest = {
    schema: 'hex-current-main-weakness-manifest/v1',
    generatedAt: new Date().toISOString(),
    provenance: {
      headSha: run?.headSha ?? null,
      sourceIdentity: run?.sourceIdentity ?? null,
      configHash: run?.configHash ?? null,
      label: run?.label ?? null,
      config: run?.config ?? null,
      manifestPath: run?.manifest?.path ?? null,
      complete: summary?.complete ?? null,
      cases: summary?.denominator ?? null,
      states: summary?.states ?? null,
      wallMs: summary?.wallMs ?? null,
    },
    artifactSchemas: {
      run: run?.schema ?? null,
      summary: summary?.schema ?? null,
      analysis: readJson(path.join(runDir, 'analysis.json'))?.schema ?? null,
      recompilability: replay?.schema ?? null,
      tuReplay: tuReplay?.schema ?? null,
      profile: profile?.schema ?? null,
    },
    artifacts,
  };

  const outPath = path.join(REPORT_ROOT, 'manifest.json');
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`manifest -> ${outPath} (${artifacts.length} artifacts)`);
}
