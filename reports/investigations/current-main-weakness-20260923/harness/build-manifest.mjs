#!/usr/bin/env node
/*
 * Hash-bind the current-main weakness investigation artifacts.
 *
 * Reads each artifact, records its sha256 and size, and writes manifest.json
 * with the measured provenance (head, sourceIdentity, configHash, harness
 * hashes). Nothing here executes production analysis.
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
