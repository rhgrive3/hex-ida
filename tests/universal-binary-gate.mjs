import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { openBinary, auditBinary } from '../js/binary/index.js';

const root = path.dirname(fileURLToPath(import.meta.url));

export const REAL_FIXTURE_TARGETS = [
  { file: 'battlecats', aliases: ['battlecats'], imports: 3000, sites: 44000, functions: 102800 },
  { file: 'TsumTsum', aliases: ['TsumTsum', 'bainary-test'], imports: 2800, sites: 54000, functions: 152400 },
  { file: 'YWP', aliases: ['YWP'], imports: 2900, sites: 92000, functions: 293700 },
];

export function isFixturePlaceholder(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return true;
    if (stat.size >= 256) return false;
    return fs.readFileSync(filePath, 'utf8').startsWith('HEX_LARGE_FIXTURE_PLACEHOLDER');
  } catch {
    return true;
  }
}

export function resolveRealFixturePath(target, {
  testsRoot = root,
  fixturesDir = process.env.HEX_REAL_FIXTURES_DIR || null,
} = {}) {
  const names = Array.isArray(target.aliases) && target.aliases.length
    ? target.aliases
    : [target.file];
  const candidates = [];
  if (fixturesDir) {
    for (const name of names) candidates.push(path.resolve(fixturesDir, name));
  } else {
    for (const name of names) candidates.push(path.join(testsRoot, '.real-fixtures', name));
    for (const name of names) candidates.push(path.join(testsRoot, name));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && !isFixturePlaceholder(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function runUniversalBinaryGate({
  testsRoot = root,
  fixturesDir = process.env.HEX_REAL_FIXTURES_DIR || null,
  allowEmpty = process.env.HEX_ALLOW_EMPTY_REAL_FIXTURES === '1',
  targets = REAL_FIXTURE_TARGETS,
} = {}) {
  let failed = false;
  let ran = 0;

  for (const t of targets) {
    const file = resolveRealFixturePath(t, { testsRoot, fixturesDir });
    if (!file) {
      console.log(`SKIP ${t.file}: fixture not present`);
      continue;
    }
    ran++;
    const bytes = new Uint8Array(fs.readFileSync(file));
    const start = performance.now();
    let image;
    try {
      image = openBinary(bytes, { metadataLimits: { records: 2_000_000, objects: 4_000_000, operations: 20_000_000, estimatedHeapBytes: 512 * 1024 * 1024 } });
    } catch (e) {
      console.error(`FAIL ${t.file}: parse: ${e.stack || e}`);
      failed = true;
      continue;
    }
    const ms = performance.now() - start;
    const audit = auditBinary(image);
    const sites = image.imports.reduce((n, x) => n + (x.sites?.length || 0), 0);
    const coverage = image.imports.length
      ? image.imports.filter((x) => x.sites?.length).length / image.imports.length
      : 0;
    const checks = [
      ['format', image.format === 'macho', image.format],
      ['arch', image.arch === 'arm64', image.arch],
      ['imports', image.imports.length >= t.imports, `${image.imports.length} >= ${t.imports}`],
      ['binding-sites', sites >= t.sites, `${sites} >= ${t.sites}`],
      ['import-site-coverage', coverage >= 0.90, `${(coverage * 100).toFixed(2)}% >= 90%`],
      ['functions', image.functions.length >= t.functions, `${image.functions.length} >= ${t.functions}`],
      ['audit-errors', audit.errors === 0, String(audit.errors)],
    ];
    console.log(`\n${t.file} (${path.relative(testsRoot, file)}, ${(bytes.length / 1048576).toFixed(1)} MiB, ${ms.toFixed(1)} ms)`);
    for (const [name, ok, detail] of checks) {
      console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
      if (!ok) failed = true;
    }
  }

  if (!ran) {
    if (allowEmpty) {
      console.log('\nNo large real-world fixtures were present (explicitly allowed via HEX_ALLOW_EMPTY_REAL_FIXTURES=1).');
      return { ok: true, ran: 0, failed: false };
    }
    console.error('\nFAIL: No large real-world fixtures were executed (ran=0). Run `npm run fixtures:fetch` or set HEX_ALLOW_EMPTY_REAL_FIXTURES=1 for synthetic-only CI.');
    return { ok: false, ran: 0, failed: true };
  }

  if (failed) return { ok: false, ran, failed: true };
  console.log(`\nuniversal-binary gate: PASS (${ran}/${targets.length} fixtures)`);
  return { ok: true, ran, failed: false };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = runUniversalBinaryGate();
  if (!result.ok) process.exit(1);
}
