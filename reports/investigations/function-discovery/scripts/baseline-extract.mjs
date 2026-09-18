#!/usr/bin/env node
/**
 * function-discovery investigation / Phase 1 baseline extraction.
 *
 * Recomputes, from the checked-out benchmark artifacts only:
 *   reports/public-benchmark/summary.json
 *   benchmarks/public/codefuse-arm64/manifest.json
 *
 * the address-union denominator, matched count, IDA-present/Hex-absent set and
 * Hex-present/IDA-absent set. Writes machine-readable evidence to a temporary
 * file, validates it, then atomically renames it into place.
 *
 * Investigation-only lane: this script never writes outside
 * reports/investigations/function-discovery/.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = '/mnt/workspace/hex-agent-e';
const REPORT_DIR = path.join(ROOT, 'reports/investigations/function-discovery');
const SUMMARY = path.join(ROOT, 'reports/public-benchmark/summary.json');
const MANIFEST = path.join(ROOT, 'benchmarks/public/codefuse-arm64/manifest.json');

const hex = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function writeAtomic(relName, doc) {
  const tmp = path.join(REPORT_DIR, `.${relName}.tmp-${process.pid}`);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  JSON.parse(fs.readFileSync(tmp, 'utf8')); // parse validation before publish
  fs.renameSync(tmp, path.join(REPORT_DIR, relName));
}

function gitRev() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const summary = JSON.parse(fs.readFileSync(SUMMARY, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

const metaById = new Map();
for (const c of manifest.cases) metaById.set(c.id, c);

const cases = summary.comparison?.cases ?? [];
if (cases.length !== summary.total) {
  throw new Error(`case count mismatch: comparison.cases=${cases.length} total=${summary.total}`);
}
const manifestIds = new Set(manifest.cases.map((c) => c.id));
for (const c of cases) {
  if (!manifestIds.has(c.caseId)) throw new Error(`case id not in manifest: ${c.caseId}`);
}

let idaTotal = 0;
let hexTotal = 0;
let matched = 0;
const idaOnly = [];
const hexOnly = [];
const perCase = [];
const dims = {
  group: {},
  compiler: {},
  optimization: {},
  debug: {},
  groupOfIdaOnly: {},
  compilerOfIdaOnly: {},
  optimizationOfIdaOnly: {},
  debugOfIdaOnly: {},
  compilerOfHexOnly: {},
  optimizationOfHexOnly: {},
  debugOfHexOnly: {},
};
const bump = (bucket, key) => {
  bucket[key] = (bucket[key] ?? 0) + 1;
};

for (const c of cases) {
  const m = metaById.get(c.caseId) ?? null;
  const group = c.caseId.split('_')[0];
  const rows = c.rows ?? [];
  let cIda = 0;
  let cHex = 0;
  let cMatch = 0;
  let cIdaOnly = 0;
  let cHexOnly = 0;
  for (const r of rows) {
    if (r.idaPresent) cIda += 1;
    if (r.hexPresent) cHex += 1;
    if (r.idaPresent && r.hexPresent) cMatch += 1;
    if (r.idaPresent && !r.hexPresent) {
      cIdaOnly += 1;
      idaOnly.push({
        caseId: c.caseId,
        group,
        binarySha256: m?.binarySha256 ?? null,
        address: r.address,
        idaName: r.idaName ?? null,
        hexName: r.hexName ?? null,
        compiler: m?.compiler ?? null,
        optimization: m?.optimization ?? null,
        debug: m?.debug ?? null,
        architecture: m?.architecture ?? null,
      });
      bump(dims.groupOfIdaOnly, group);
      bump(dims.compilerOfIdaOnly, m?.compiler ?? 'unknown');
      bump(dims.optimizationOfIdaOnly, m?.optimization ?? 'unknown');
      bump(dims.debugOfIdaOnly, String(m?.debug));
    }
    if (!r.idaPresent && r.hexPresent) {
      cHexOnly += 1;
      hexOnly.push({
        caseId: c.caseId,
        group,
        binarySha256: m?.binarySha256 ?? null,
        address: r.address,
        idaName: r.idaName ?? null,
        hexName: r.hexName ?? null,
        compiler: m?.compiler ?? null,
        optimization: m?.optimization ?? null,
        debug: m?.debug ?? null,
      });
      bump(dims.compilerOfHexOnly, m?.compiler ?? 'unknown');
      bump(dims.optimizationOfHexOnly, m?.optimization ?? 'unknown');
      bump(dims.debugOfHexOnly, String(m?.debug));
    }
  }
  idaTotal += cIda;
  hexTotal += cHex;
  matched += cMatch;
  perCase.push({
    caseId: c.caseId,
    group,
    denominator: c.denominator,
    idaFunctions: c.idaFunctions,
    hexFunctions: c.hexFunctions,
    matchedByAddress: c.matchedByAddress,
    rows: rows.length,
    idaOnly: cIdaOnly,
    hexOnly: cHexOnly,
    compiler: m?.compiler ?? null,
    optimization: m?.optimization ?? null,
    debug: m?.debug ?? null,
  });
  bump(dims.group, group);
  bump(dims.compiler, m?.compiler ?? 'unknown');
  bump(dims.optimization, m?.optimization ?? 'unknown');
  bump(dims.debug, String(m?.debug));
}

idOnly: {
  const aggregate = summary.comparison?.aggregate ?? {};
  const denominator = aggregate.denominator ?? null;
  const recomputed = {
    cases: cases.length,
    denominator,
    denominatorMatchesAggregate: denominator === aggregate.denominator,
    idaPresentTotal: idaTotal,
    hexPresentTotal: hexTotal,
    aggregateIda: aggregate.ida ?? null,
    aggregateHex: aggregate.hex ?? null,
    matchedByAddress: matched,
    aggregateMatched: aggregate.matched ?? null,
    idaOnlyCount: idaOnly.length,
    hexOnlyCount: hexOnly.length,
    idaOnlyFromAggregate: (aggregate.ida ?? 0) - (aggregate.matched ?? 0),
    hexOnlyFromAggregate: (aggregate.hex ?? 0) - (aggregate.matched ?? 0),
    unionDerived: idaTotal + hexTotal - matched,
    denominatorFrozen: summary.denominatorFrozen ?? null,
    scope: summary.comparison?.scope ?? null,
  };

  const result = {
    schema: 'hex-function-discovery-investigation/ida-only-functions/v1',
    generatedAt: new Date().toISOString(),
    baseSha: summary.provenance?.git?.sha ?? null,
    baseShaDirty: summary.provenance?.git?.dirty ?? null,
    checkoutSha: gitRev(),
    evidence: {
      summaryPath: 'reports/public-benchmark/summary.json',
      summarySha256: hex(SUMMARY),
      summarySchema: summary.schema ?? null,
      manifestPath: 'benchmarks/public/codefuse-arm64/manifest.json',
      manifestSha256: hex(MANIFEST),
      manifestSchema: manifest.schema ?? null,
      manifestFrozenAt: manifest.frozenAt ?? null,
      reference: manifest.reference ?? null,
    },
    recomputed,
    distributions: dims,
    idaOnlyFunctions: idaOnly,
    hexOnlyFunctions: hexOnly,
    perCase,
  };

  // Fail-closed validation before publishing (EP-015).
  if (recomputed.idaOnlyCount !== recomputed.idaOnlyFromAggregate) {
    throw new Error(
      `ida-only enumeration (${recomputed.idaOnlyCount}) != aggregate difference (${recomputed.idaOnlyFromAggregate})`,
    );
  }
  if (recomputed.hexOnlyCount !== recomputed.hexOnlyFromAggregate) {
    throw new Error(
      `hex-only enumeration (${recomputed.hexOnlyCount}) != aggregate difference (${recomputed.hexOnlyFromAggregate})`,
    );
  }
  if (!denominator) throw new Error('missing denominator');
  for (const f of idaOnly) {
    for (const k of ['caseId', 'address', 'binarySha256', 'idaName']) {
      if (f[k] === null || f[k] === undefined) {
        throw new Error(`ida-only row missing ${k}: ${JSON.stringify(f)}`);
      }
    }
  }

  writeAtomic('ida-only-functions.json', result);
  writeAtomic('hex-only-functions.json', {
    schema: 'hex-function-discovery-investigation/hex-only-functions/v1',
    generatedAt: result.generatedAt,
    baseSha: result.baseSha,
    checkoutSha: result.checkoutSha,
    evidence: result.evidence,
    recomputed,
    hexOnlyFunctions: hexOnly,
  });
  writeAtomic('per-case-comparison.json', {
    schema: 'hex-function-discovery-investigation/per-case-comparison/v1',
    generatedAt: result.generatedAt,
    baseSha: result.baseSha,
    recomputed,
    perCase,
  });

  console.log(JSON.stringify({ recomputed, distributions: dims }, null, 2));
}
