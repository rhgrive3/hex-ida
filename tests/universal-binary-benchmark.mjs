import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { openBinarySource, auditBinary } from '../js/binary/index.js';
import { NodeFileByteSource } from '../js/bytesource/node.js';
import { InstrumentedByteSource } from '../js/bytesource/cached.js';
import { median, SCHEMA_VERSION } from '../tools/benchmark/schema.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(root, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'real-binaries.json'), 'utf8'));
const cliFiles = process.argv.slice(2);
const defaultRun = cliFiles.length === 0;
const sampleCount = Number(process.env.HEX_BENCHMARK_SAMPLES || 3);
if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 9) throw new Error('HEX_BENCHMARK_SAMPLES must be an integer from 1 to 9');
const files = defaultRun
  ? Object.entries(manifest.fixtures).map(([name, spec]) => ({ name, path: path.join(root, '.real-fixtures', spec.file), spec }))
  : cliFiles.map((file) => ({ name: path.basename(file), path: file, spec: null }));

async function digestFile(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest('hex') };
}

async function verifyPinnedFixture(target) {
  if (!target.spec) return null;
  if (!fs.existsSync(target.path)) throw new Error(`${target.name}: required fixture is missing at ${path.relative(repoRoot, target.path)}`);
  const digest = await digestFile(target.path);
  if (digest.size !== target.spec.size) throw new Error(`${target.name}: size mismatch (${digest.size} != ${target.spec.size})`);
  if (digest.sha256 !== target.spec.sha256) throw new Error(`${target.name}: SHA-256 mismatch`);
  return digest;
}

async function sample(file) {
  const nodeSource = await NodeFileByteSource.open(file, { maxReadLength: 8 * 1024 * 1024 });
  try {
    const source = new InstrumentedByteSource(nodeSource);
    const before = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const image = await openBinarySource(source, { ranges: { pageSize: 64 * 1024, maxPageSize: 2 * 1024 * 1024, maxCachedBytes: 16 * 1024 * 1024 } });
    const loaderMs = performance.now() - t0;
    const audit = auditBinary(image);
    const auditErrorCodes = audit.issues.filter((issue) => issue.level === 'error').map((issue) => issue.code).join('__') || 'none';
    const legacyOwner = (address) => {
      let best = null;
      const consider = (mapping, mapped = true) => {
        if (!mapped || mapping.size <= 0n || address < mapping.address || address >= mapping.address + mapping.size) return;
        if (!best || mapping.size < best.size) best = mapping;
      };
      for (const mapping of image.sections) consider(mapping, mapping.source !== 'unmapped-section' && !(mapping.source === 'section-header' && (BigInt(mapping.flags || 0) & 2n) === 0n));
      for (const mapping of image.segments) consider(mapping);
      return best;
    };
    const describeOwner = (mapping) => mapping
      ? mapping.name + '@' + mapping.address.toString(16) + '/' + mapping.size.toString(16) + ':f' + mapping.fileOffset.toString(16) + '/' + mapping.fileSize.toString(16)
      : 'none';
    const auditErrorDetails = audit.issues.filter((issue) => issue.level === 'error').map((issue) => {
      const values = [...String(issue.message).matchAll(/0x[0-9A-Fa-f]+/g)].map((match) => BigInt(match[0]));
      const address = issue.code === 'offset-address-roundtrip' ? values[1] : values[0];
      return issue.code + ':current=' + describeOwner(image._virtualMappingAt(address)) + ':legacy=' + describeOwner(legacyOwner(address));
    }).join('__').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 70);
    const auditDiagnosticDir = path.join(repoRoot, 'benchmark-diagnostic');
    fs.mkdirSync(auditDiagnosticDir, { recursive: true });
    const auditDiagnosticName = String(path.basename(file)) + '-audit-' + String(audit.errors) + '-' + auditErrorCodes.slice(0, 120) + '-' + auditErrorDetails + '.json';
    fs.writeFileSync(path.join(auditDiagnosticDir, auditDiagnosticName), JSON.stringify({ errors: audit.errors, issues: audit.issues.filter((issue) => issue.level === 'error') }));
    const after = process.memoryUsage().heapUsed;
    const io = source.metrics();
    return {
      loaderMs: Number(loaderMs.toFixed(3)),
      heapDeltaMiB: Number(((after - before) / 1048576).toFixed(3)),
      work: {
        rangeReads: io.reads,
        totalRequestedBytes: io.totalRequested,
        largestSingleRead: io.largestSingleRead,
      },
      identity: {
        bytes: Number(nodeSource.size),
        format: image.format,
        arch: image.arch,
        sourceBacked: image.bytes === null,
        sections: image.sections.length,
        imports: image.imports.length,
        importSites: image.imports.reduce((n, x) => n + (x.sites?.length || 0), 0),
        functionSeeds: image.functions.length,
        symbols: image.symbols.length,
        exports: image.exports.length,
        auditErrors: audit.errors,
        auditWarnings: audit.warnings,
      },
    };
  } finally {
    await nodeSource.close();
  }
}

const report = {
  schema: SCHEMA_VERSION,
  kind: 'binary-benchmark',
  policy: {
    wallClock: 'informational',
    deterministicWork: 'blocking-compatible',
    note: 'Wall-clock and heap deltas are observations only. Regression gates use correctness plus deterministic I/O work units.',
  },
  samplesPerTarget: sampleCount,
  targets: {},
};

let currentTarget = 'initializing';
const heartbeat = setInterval(() => {
  console.error(`[binary-benchmark] still running (${currentTarget})`);
}, 30_000);
try {
  for (const target of files) {
    currentTarget = target.name;
    const fixtureDigest = await verifyPinnedFixture(target);
  if (!target.spec && !fs.existsSync(target.path)) throw new Error(`${target.name}: benchmark input is missing at ${target.path}`);
  const samples = [];
    for (let i = 0; i < sampleCount; i++) {
      console.error(`[binary-benchmark] ${target.name} sample ${i + 1}/${sampleCount}`);
      samples.push(await sample(target.path));
    }
  const identity = samples[0].identity;
  for (const row of samples.slice(1)) {
    if (JSON.stringify(row.identity) !== JSON.stringify(identity)) throw new Error(`${target.name}: non-deterministic loader identity across benchmark samples`);
  }
  report.targets[target.name] = {
    fixture: fixtureDigest ? { size: fixtureDigest.size, sha256: fixtureDigest.sha256 } : { status: 'unverified-ad-hoc' },
    ...identity,
    timing: {
      loaderMs: { samples: samples.map((x) => x.loaderMs), median: Number(median(samples.map((x) => x.loaderMs)).toFixed(3)) },
      heapDeltaMiB: { samples: samples.map((x) => x.heapDeltaMiB), median: Number(median(samples.map((x) => x.heapDeltaMiB)).toFixed(3)) },
    },
    work: {
      rangeReads: median(samples.map((x) => x.work.rangeReads)),
      totalRequestedBytes: median(samples.map((x) => x.work.totalRequestedBytes)),
      largestSingleRead: Math.max(...samples.map((x) => x.work.largestSingleRead)),
      samples: samples.map((x) => x.work),
    },
  };
  }
} catch (error) {
  const diagnosticName = String(error?.name || 'Error').replace(/[^A-Za-z0-9._-]+/g, '-');
  const diagnosticCode = String(error?.code || 'NO_CODE').replace(/[^A-Za-z0-9._-]+/g, '-');
  const diagnosticTarget = String(currentTarget || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-');
  const diagnosticMessage = String(error?.message || error)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .slice(0, 96)
    .replace(/-+$/g, '');
  const diagnosticDir = path.join(repoRoot, 'benchmark-diagnostic');
  fs.mkdirSync(diagnosticDir, { recursive: true });
  fs.writeFileSync(
    path.join(diagnosticDir, `${diagnosticTarget}-${diagnosticCode}-${diagnosticName}-${diagnosticMessage || 'failure'}.json`),
    JSON.stringify({ target: currentTarget, name: error?.name || 'Error', code: error?.code || null, message: String(error?.message || error) }),
  );
  throw error;
} finally {
  clearInterval(heartbeat);
}

if (defaultRun && Object.keys(report.targets).length !== Object.keys(manifest.fixtures).length) {
  throw new Error('default benchmark did not run every pinned real fixture');
}

const metricTag = Object.entries(report.targets)
  .map(([name, row]) => `${name}-r${row.work.rangeReads}-b${row.work.totalRequestedBytes}`)
  .join('__');
const metricDiagnosticDir = path.join(repoRoot, 'benchmark-diagnostic');
fs.mkdirSync(metricDiagnosticDir, { recursive: true });
fs.writeFileSync(path.join(metricDiagnosticDir, `metrics-${metricTag}.json`), JSON.stringify({ kind: 'binary-benchmark-metrics', targets: report.targets }));

console.log(JSON.stringify(report, null, 2));