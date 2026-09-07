/**
 * Capture same-binary twin provenance for the repository-owned competitive
 * workloads.
 *
 * This module is deliberately an evidence collector, not a score producer.
 * The Phase 5/6 builders already enforce their frozen compiler/linker
 * identities. Phase 8 and the benchmark baseline have separate identity
 * contracts, so a capture is returned as READY only when those identities and
 * the actual artifact pair are available. Missing tools, source provenance,
 * or artifacts remain explicit non-pass states.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { stableDigest } from '../../../js/core/identity/index.js';
import competitiveProfile from './profile.json' with { type: 'json' };
import {
  generateTwinManifest,
  validateTwinManifest,
} from './twin-manifest.mjs';
import { buildVerificationCorpus } from '../phase5/build-verification-corpus.mjs';
import { buildPhase6VerificationCorpus } from '../phase6/build-verification-corpus.mjs';
import { buildCorpus as buildPhase8Corpus } from '../phase8/build-corpus.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PHASE8_SOURCE_DIRECTORY = path.join(ROOT, 'tests/phase8/corpus/sources');
const EXPECTED_PHASE8_COMPILER_VERSION = competitiveProfile.compilerCorpusGeneratorVersions?.clang || null;
const PHASE8_NATIVE_ARM64_TARGET = Object.freeze({
  architectureId: 'arm64',
  targetTriple: 'aarch64-unknown-linux-gnu',
  compilerArgs: Object.freeze([]),
});
const PHASE8_OPTIMIZATION_LEVELS = Object.freeze(['-O0', '-O1', '-O2']);
const BENCHMARK_FIXTURE_MANIFEST_PATH = path.join(ROOT, 'tests/fixtures/real-binaries.json');
const BENCHMARK_FIXTURE_DIRECTORY = path.join(ROOT, 'tests/.real-fixtures');
const BENCHMARK_IDENTITY_MANIFEST_PATH = path.join(ROOT, 'tests/fixtures/real-binary-twin-identity.json');

export const COMPETITIVE_TWIN_CAPTURE_SCHEMA = 'hex-competitive-twin-capture/v1';
export const COMPETITIVE_TWIN_TRUTH_SCHEMA = 'hex-competitive-twin-truth/v1';

/**
 * Every binary competitive row has one declared producer. The two Phase 8
 * rows intentionally share the same corpus capture because they score
 * different observations over the same frozen machine-byte workload.
 */
export const COMPETITIVE_TWIN_WORKLOADS = Object.freeze({
  'machine-effects-x86_64-coverage': Object.freeze({
    workloadId: 'phase5-p5-6-generated-corpus',
    producer: 'tools/validation/phase5/build-verification-corpus.mjs',
    kind: 'compiler-corpus',
  }),
  'machine-effects-riscv64-coverage': Object.freeze({
    workloadId: 'phase6-riscv64-generated-corpus',
    producer: 'tools/validation/phase6/build-verification-corpus.mjs',
    kind: 'compiler-corpus',
  }),
  'decompiler-quality-gotos': Object.freeze({
    workloadId: 'phase8-decompiler-quality-corpus',
    producer: 'tools/validation/phase8/build-corpus.mjs',
    kind: 'decompiler-corpus',
  }),
  'decompiler-quality-assembly-fallbacks': Object.freeze({
    workloadId: 'phase8-decompiler-quality-corpus',
    producer: 'tools/validation/phase8/build-corpus.mjs',
    kind: 'decompiler-corpus',
  }),
  'universal-binary-hotpath-ms': Object.freeze({
    workloadId: 'benchmark-baseline-real-binaries',
    producer: 'tests/benchmark-baseline.mjs',
    kind: 'benchmark-binary',
  }),
});

const STATUS = Object.freeze({
  READY: 'READY',
  BLOCKED_TOOLCHAIN: 'BLOCKED-TOOLCHAIN',
  NOT_INTEGRATED: 'NOT-INTEGRATED',
  INVALID: 'INVALID',
});

const MEASUREMENT_STATUS = 'UNMEASURED';
const TRUTH_AUTHORITY = 'same-binary-twin';
const TRUTH_REASON = 'same-binary-twin-binds-artifact-identity-only';

function firstLine(value) {
  return String(value || '').split(/\r?\n/, 1)[0].trim();
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function executableInDirectory(directory, names) {
  for (const name of names) {
    const candidate = directory == null ? name : path.join(directory, name);
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}

function toolVersion(command) {
  if (!command) return null;
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return firstLine(result.stdout || result.stderr);
}

function relativeIdentity(value) {
  if (typeof value !== 'string') return value;
  if (!path.isAbsolute(value)) return value;
  const relative = path.relative(ROOT, value).replaceAll('\\', '/');
  return relative && !relative.startsWith('../') && relative !== '..' ? relative : path.basename(value);
}

function normalizedCompileArgs(args = []) {
  return args.map((arg) => relativeIdentity(arg));
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => String(left).localeCompare(String(right)));
}

function canonicalArtifactIdentity(artifact) {
  const manifest = artifact.manifest;
  const debugSidecars = [...(artifact.debugSidecars || [])]
    .map((sidecar) => ({ id: sidecar.id, sha256: sidecar.sha256 }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    id: artifact.id,
    corpusId: manifest.corpusId,
    corpusVersion: manifest.corpusVersion,
    sourceIdentity: manifest.sourceIdentity,
    compiler: manifest.compiler,
    targetTriple: manifest.targetTriple,
    architecture: manifest.architecture,
    profile: manifest.profile,
    compileArgs: manifest.compileArgs,
    compileOptions: manifest.compileOptions,
    linker: manifest.linker,
    buildIdentity: manifest.buildIdentity,
    debugArtifactSha256: manifest.debugArtifactSha256,
    strippedArtifactSha256: manifest.strippedArtifactSha256,
    manifestDigest: manifest.manifestDigest,
    debugSidecars,
  };
}

function captureIdentity({ metricId, workloadId, producer, kind, corpusId, corpusVersion, artifacts }) {
  const identities = artifacts.map(canonicalArtifactIdentity).sort((left, right) => left.id.localeCompare(right.id));
  const artifactIds = identities.map((artifact) => artifact.id);
  return {
    schemaVersion: COMPETITIVE_TWIN_CAPTURE_SCHEMA,
    metricId,
    workloadId,
    producer: producer ?? null,
    kind: kind ?? null,
    corpusId,
    corpusVersion,
    artifactIds,
    artifactIdsDigest: stableDigest(artifactIds),
    sourceIdentities: sortedUnique(identities.map((artifact) => stableDigest(artifact.sourceIdentity))),
    compilerIdentities: sortedUnique(identities.map((artifact) => stableDigest(artifact.compiler))),
    linkerIdentities: sortedUnique(identities.map((artifact) => stableDigest(artifact.linker))),
    buildIdentities: identities.map((artifact) => artifact.buildIdentity),
    artifacts: identities,
  };
}

function captureDigest(identity) {
  return stableDigest(identity);
}

function unmeasuredTruthBinding({ metricId, workloadId, corpusId, corpusVersion, identity }) {
  return Object.freeze({
    schemaVersion: COMPETITIVE_TWIN_TRUTH_SCHEMA,
    metricId,
    workloadId,
    corpusId,
    corpusVersion,
    authority: TRUTH_AUTHORITY,
    status: MEASUREMENT_STATUS,
    competitorOutputIsNeverAuthority: true,
    manifestDigests: Object.freeze(identity.artifacts.map((artifact) => artifact.manifestDigest)),
    semanticOracle: null,
    reason: TRUTH_REASON,
  });
}

function emptyMeasurement(productionObservation = null) {
  return Object.freeze({
    status: MEASUREMENT_STATUS,
    candidateValue: null,
    referenceValue: null,
    comparison: MEASUREMENT_STATUS,
    reason: 'independent-semantic-oracle-not-captured',
    productionObservation,
  });
}

function productionArtifactObservation(artifacts) {
  const rows = artifacts.map((artifact) => Object.freeze({
    id: artifact.id,
    debugBytes: fs.statSync(artifact.debugArtifactPath).size,
    strippedBytes: fs.statSync(artifact.strippedArtifactPath).size,
    debugArtifactSha256: artifact.manifest.debugArtifactSha256,
    strippedArtifactSha256: artifact.manifest.strippedArtifactSha256,
    debugSidecars: Object.freeze([...(artifact.debugSidecars || [])].map((sidecar) => Object.freeze({ id: sidecar.id, sha256: sidecar.sha256 }))),
  })).sort((left, right) => left.id.localeCompare(right.id));
  return Object.freeze({
    artifactCount: rows.length,
    debugBytes: rows.reduce((sum, row) => sum + row.debugBytes, 0),
    strippedBytes: rows.reduce((sum, row) => sum + row.strippedBytes, 0),
    rows: Object.freeze(rows),
    digest: stableDigest(rows),
  });
}

function unavailableCapture({ metricId, workloadId, producer = null, kind = null, status, corpusId = null, corpusVersion = null, reason, errorCode = null, details = null }) {
  return Object.freeze({
    schemaVersion: COMPETITIVE_TWIN_CAPTURE_SCHEMA,
    metricId,
    workloadId,
    producer,
    kind,
    status,
    corpusId,
    corpusVersion,
    denominator: Object.freeze({ artifactCount: 0, artifactIds: Object.freeze([]), artifactIdsDigest: stableDigest([]) }),
    identity: null,
    truthBinding: null,
    measurement: emptyMeasurement(),
    artifacts: Object.freeze([]),
    reason,
    errorCode,
    ...(details == null ? {} : { details: Object.freeze(details) }),
  });
}

function assertDebugBuildMetadata(metadata, artifactId = 'unknown') {
  const options = metadata?.compileOptions;
  const args = metadata?.compileArgs;
  if (options?.debug !== true || !Array.isArray(args) || !args.includes('-g')) {
    throw new Error(`debug-artifact-metadata-required:${artifactId}`);
  }
}

function sourceIdentity(source) {
  if (!source || typeof source !== 'object' || typeof source.path !== 'string' || typeof source.sha256 !== 'string') {
    throw new TypeError('competitive-twin-source-identity-missing');
  }
  return {
    id: relativeIdentity(source.path),
    sha256: source.sha256,
  };
}

function architectureFor(fixture, fallback = null) {
  const target = String(fixture.target || '');
  if (target.includes('riscv')) return { id: 'riscv64', profile: 'rv64imc' };
  if (target.includes('microsoft')) return { id: 'x86_64', profile: 'long-64-microsoft-x64' };
  if (target.includes('sysv') || fallback === 'x86_64') return { id: 'x86_64', profile: 'long-64' };
  if (target.includes('aarch64') || fallback === 'arm64') return { id: 'arm64', profile: 'aarch64-linux-gnu' };
  return { id: fallback || 'unknown', profile: 'unknown' };
}

function compilerIdentity(toolchain) {
  return {
    id: path.basename(toolchain.clang || 'clang'),
    version: firstLine(toolchain.compilerVersion),
  };
}

function linkerIdentity(toolchain) {
  return {
    id: path.basename(toolchain.lld || 'ld.lld'),
    version: firstLine(toolchain.linkerVersion),
    options: {},
  };
}

function buildIdentity({ corpusId, corpusVersion, source, fixture, toolchain }) {
  return stableDigest({
    corpusId,
    corpusVersion,
    source,
    fixture: {
      id: fixture.id,
      target: fixture.target,
      targetTriple: fixture.targetTriple,
      optimization: fixture.optimization,
      flags: normalizedCompileArgs(fixture.flags || []),
      sha256: fixture.sha256,
    },
    toolchain: {
      compiler: compilerIdentity(toolchain),
      linker: linkerIdentity(toolchain),
    },
  });
}

function debugSidecarPathForFixture(fixture) {
  if (typeof fixture?.path !== 'string' || !fixture.path.endsWith('.exe')) return null;
  return fixture.path.replace(/\.exe$/, '.pdb');
}

function debugSidecarForFixture(fixture) {
  const sidecarPath = debugSidecarPathForFixture(fixture);
  if (sidecarPath == null) return null;
  if (!fs.existsSync(sidecarPath)) throw new Error(`debug-sidecar-missing:${fixture.id}`);
  return {
    id: 'pdb',
    sha256: sha256File(sidecarPath),
  };
}

function phase5Metadata(corpus, fixture) {
  const source = sourceIdentity(corpus.source);
  const supportSource = sourceIdentity(corpus.supportSource);
  const debugSidecar = debugSidecarForFixture(fixture);
  return {
    corpusId: 'phase5-p5-6-generated-corpus',
    corpusVersion: 1,
    sourceIdentity: source,
    compiler: compilerIdentity(corpus.toolchain),
    targetTriple: fixture.targetTriple,
    architecture: architectureFor(fixture),
    profile: `${fixture.target}-${fixture.optimization}`,
    compileArgs: normalizedCompileArgs(fixture.flags),
    compileOptions: {
      generator: 'phase5-p5-6-generated-corpus/v1',
      debug: true,
      optimization: fixture.optimization,
      supportSource,
      ...(debugSidecar == null ? {} : { debugSidecar }),
    },
    linker: linkerIdentity(corpus.toolchain),
    buildIdentity: buildIdentity({ corpusId: 'phase5-p5-6-generated-corpus', corpusVersion: 1, source, fixture, toolchain: corpus.toolchain }),
  };
}

function phase6Metadata(corpus, fixture) {
  const source = sourceIdentity(corpus.source);
  const targetTriple = 'riscv64-unknown-elf';
  const normalizedFixture = { ...fixture, targetTriple };
  return {
    corpusId: corpus.corpusId || 'phase6-riscv64-generated-corpus',
    corpusVersion: Number.isSafeInteger(corpus.profileVersion) ? corpus.profileVersion : 1,
    sourceIdentity: source,
    compiler: compilerIdentity(corpus.toolchain),
    targetTriple,
    architecture: architectureFor(fixture, 'riscv64'),
    profile: `${fixture.target}-${fixture.optimization}`,
    compileArgs: normalizedCompileArgs(fixture.flags),
    compileOptions: {
      generator: 'phase6-generated-corpus/v1',
      debug: true,
      optimization: fixture.optimization,
      isa: 'rv64im',
      abi: fixture.abiId,
    },
    linker: linkerIdentity(corpus.toolchain),
    buildIdentity: buildIdentity({ corpusId: corpus.corpusId || 'phase6-riscv64-generated-corpus', corpusVersion: Number.isSafeInteger(corpus.profileVersion) ? corpus.profileVersion : 1, source, fixture: normalizedFixture, toolchain: corpus.toolchain }),
  };
}

function phase8Linker(clang) {
  const directory = path.dirname(clang || '');
  const command = executableInDirectory(directory, ['ld.lld-18', 'ld.lld', 'lld']);
  const fallback = command || executableInDirectory(null, ['ld.lld-18', 'ld.lld', 'lld']);
  const version = toolVersion(fallback);
  return fallback && version ? { id: path.basename(fallback), version, options: {} } : null;
}

function runPhase8NativeArm64Command(clang, args, label) {
  const result = spawnSync(clang, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || 'unknown compiler failure').trim().slice(0, 400);
    const error = new Error(`phase8-arm64-native-${label}-failed:${detail}`);
    error.code = 'P8_ARM64_NATIVE_TOOLCHAIN_FAILURE';
    throw error;
  }
}

/**
 * Build capture-only ARM64 native artifacts.  The canonical Phase 8 builder
 * intentionally keeps ARM64 as historical assembly, so this path never
 * changes functions.json or the default corpus denominator.  It emits one
 * debug-bearing linked ELF per source/optimization pair for twin capture.
 */
function buildPhase8NativeArm64Artifacts({ clang, artifactDirectory }) {
  if (typeof artifactDirectory !== 'string' || !artifactDirectory.trim()) {
    throw new TypeError('phase8-arm64-native-artifact-directory-required');
  }
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const sources = fs.readdirSync(PHASE8_SOURCE_DIRECTORY)
    .filter((name) => name.endsWith('.c'))
    .sort();
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-phase8-arm64-native-'));
  const supportObjects = new Map();
  const artifacts = [];
  try {
    const supportSourcePath = path.join(temporaryDirectory, 'arm64-link-support.c');
    fs.writeFileSync(supportSourcePath, '__attribute__((noinline,used)) void opaque(void) { __asm__ __volatile__("" ::: "memory"); }\n');
    for (const optimization of PHASE8_OPTIMIZATION_LEVELS) {
      const supportObjectPath = path.join(temporaryDirectory, `arm64-link-support-${optimization.slice(1)}.o`);
      runPhase8NativeArm64Command(clang, [
        `--target=${PHASE8_NATIVE_ARM64_TARGET.targetTriple}`,
        '-g',
        optimization,
        '-c',
        '-fno-asynchronous-unwind-tables',
        '-o', supportObjectPath,
        supportSourcePath,
      ], `support-${optimization}`);
      supportObjects.set(optimization, supportObjectPath);
    }
    for (const sourceName of sources) {
      const sourcePath = path.join(PHASE8_SOURCE_DIRECTORY, sourceName);
      for (const optimization of PHASE8_OPTIMIZATION_LEVELS) {
        const stem = `arm64-native-${path.basename(sourceName)}-${optimization.slice(1)}`;
        const objectPath = path.join(temporaryDirectory, `${stem}.o`);
        const linkedPath = path.join(temporaryDirectory, `${stem}.elf`);
        runPhase8NativeArm64Command(clang, [
          `--target=${PHASE8_NATIVE_ARM64_TARGET.targetTriple}`,
          ...PHASE8_NATIVE_ARM64_TARGET.compilerArgs,
          '-g',
          optimization,
          '-c',
          '-fno-asynchronous-unwind-tables',
          '-o', objectPath,
          sourcePath,
        ], `${sourceName}-${optimization}`);
        runPhase8NativeArm64Command(clang, [
          `--target=${PHASE8_NATIVE_ARM64_TARGET.targetTriple}`,
          ...PHASE8_NATIVE_ARM64_TARGET.compilerArgs,
          '-fuse-ld=lld',
          '-nostdlib',
          '-no-pie',
          '-Wl,--build-id=none',
          '-Wl,-e,0',
          '-o', linkedPath,
          objectPath,
          supportObjects.get(optimization),
        ], `link-${sourceName}-${optimization}`);
        const capturedPath = path.join(artifactDirectory, `${stem}.elf`);
        fs.copyFileSync(linkedPath, capturedPath);
        artifacts.push({
          id: stem,
          source: sourceName,
          architectureId: PHASE8_NATIVE_ARM64_TARGET.architectureId,
          targetTriple: PHASE8_NATIVE_ARM64_TARGET.targetTriple,
          optimization,
          representation: 'machine-bytes',
          captureOnly: true,
          path: capturedPath,
          sha256: sha256File(capturedPath),
          size: fs.statSync(capturedPath).size,
        });
      }
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  return artifacts;
}

function phase8Metadata(corpus, artifact, clang, source) {
  const architecture = architectureFor(artifact, artifact.architectureId);
  const compiler = { id: path.basename(clang), version: firstLine(corpus.toolchain.compiler) };
  const linker = phase8Linker(clang);
  if (!linker) throw new Error('phase8-linker-identity-unavailable');
  const compileArgs = [
    `--target=${artifact.targetTriple}`,
    ...(corpus.toolchain.targets.find((target) => target.architectureId === artifact.architectureId)?.compilerArgs || []),
    ...(corpus.debug === true ? ['-g'] : []),
    artifact.optimization,
    '-c',
    '-fno-asynchronous-unwind-tables',
    '-fuse-ld=lld',
    '-nostdlib',
    '-no-pie',
    '-Wl,--build-id=none',
    '-Wl,-e,0',
  ];
  const fixture = {
    id: artifact.id,
    target: artifact.architectureId,
    targetTriple: artifact.targetTriple,
    optimization: artifact.optimization,
    flags: compileArgs,
    sha256: artifact.sha256,
  };
  return {
    corpusId: corpus.corpusId,
    corpusVersion: corpus.corpusVersion,
    sourceIdentity: sourceIdentity(source),
    compiler,
    targetTriple: artifact.targetTriple,
    architecture,
    profile: `${artifact.architectureId}-${artifact.optimization}`,
    compileArgs,
    compileOptions: {
      generator: 'phase8-decompiler-quality-corpus/v2',
      debug: true,
      optimization: artifact.optimization,
      representation: artifact.representation || 'machine-bytes',
      ...(artifact.captureOnly === true ? { captureOnly: true } : {}),
    },
    linker,
    buildIdentity: buildIdentity({ corpusId: corpus.corpusId, corpusVersion: corpus.corpusVersion, source, fixture, toolchain: { clang, compilerVersion: corpus.toolchain.compiler, lld: linker.id, linkerVersion: linker.version } }),
  };
}

function stripToolEnvironment(artifactRoot, preferred = 'strip', candidates = []) {
  const names = preferred === 'llvm-strip' ? ['llvm-strip', 'llvm-strip-18'] : ['strip'];
  const direct = executableInDirectory(null, names);
  if (direct && (path.basename(direct) === preferred || preferred === 'strip')) {
    return { id: preferred, restore: () => {} };
  }
  if (preferred !== 'llvm-strip') return null;
  const actual = direct || candidates.find((candidate) => {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    return !result.error && result.status === 0;
  });
  if (!actual) return null;
  const alias = path.join(artifactRoot, 'llvm-strip');
  try { fs.symlinkSync(actual, alias); } catch { return null; }
  const previousPath = process.env.PATH;
  process.env.PATH = `${artifactRoot}${path.delimiter}${previousPath || ''}`;
  return {
    id: 'llvm-strip',
    restore: () => { process.env.PATH = previousPath; try { fs.unlinkSync(alias); } catch { /* best effort */ } },
  };
}

function debugSidecarEvidence(artifact) {
  const sidecars = artifact.debugSidecars ?? [];
  if (!Array.isArray(sidecars)) throw new Error(`debug-sidecars-array-required:${artifact.id}`);
  const observed = [];
  for (const sidecar of sidecars) {
    if (sidecar == null || typeof sidecar !== 'object' || typeof sidecar.id !== 'string' || !sidecar.id.trim()) {
      throw new Error(`debug-sidecar-id-required:${artifact.id}`);
    }
    if (typeof sidecar.path !== 'string' || !fs.existsSync(sidecar.path)) {
      throw new Error(`debug-sidecar-missing:${artifact.id}:${sidecar.id}`);
    }
    const digest = sha256File(sidecar.path);
    if (typeof sidecar.sha256 !== 'string' || sidecar.sha256.toLowerCase() !== digest) {
      throw new Error(`debug-sidecar-digest-mismatch:${artifact.id}:${sidecar.id}`);
    }
    observed.push({ id: sidecar.id, path: sidecar.path, sha256: digest });
  }
  const expected = [...(artifact.metadata?.compileOptions?.debugSidecar == null
    ? []
    : [artifact.metadata.compileOptions.debugSidecar])]
    .map((sidecar) => ({ id: sidecar.id, sha256: sidecar.sha256 }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const actual = observed.map(({ id, sha256: digest }) => ({ id, sha256: digest }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (stableDigest(actual) !== stableDigest(expected)) throw new Error(`debug-sidecar-identity-mismatch:${artifact.id}`);
  return observed;
}

export function captureTwinArtifacts({
  metricId,
  workloadId,
  producer = null,
  kind = null,
  corpusId,
  corpusVersion,
  artifactRoot,
  artifacts,
  stripTool = 'strip',
  stripCandidates = [],
}) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return unavailableCapture({
      metricId,
      workloadId,
      producer,
      kind,
      status: STATUS.NOT_INTEGRATED,
      corpusId,
      corpusVersion,
      reason: 'no-debug-artifacts-produced',
    });
  }
  const captured = [];
  const stripEnvironment = stripToolEnvironment(artifactRoot, stripTool, stripCandidates);
  if (!stripEnvironment) {
    return unavailableCapture({
      metricId,
      workloadId,
      producer,
      kind,
      status: STATUS.BLOCKED_TOOLCHAIN,
      corpusId,
      corpusVersion,
      reason: `${stripTool}-unavailable`,
    });
  }
  try {
    for (const artifact of artifacts) {
      if (!artifact?.path || !fs.existsSync(artifact.path)) throw new Error(`artifact-missing:${artifact?.id || 'unknown'}`);
      if (typeof artifact.id !== 'string' || !artifact.id.trim()) throw new Error('artifact-id-required');
      assertDebugBuildMetadata(artifact.metadata, artifact.id);
      const debugSidecars = debugSidecarEvidence(artifact);
      const strippedArtifactPath = path.join(artifactRoot, `${artifact.id}.stripped`);
      const manifest = generateTwinManifest({
        debugArtifactPath: artifact.path,
        strippedArtifactPath,
        ...artifact.metadata,
        stripTool: stripEnvironment.id,
      });
      const replay = validateTwinManifest(manifest, {
        debugArtifactPath: artifact.path,
        strippedArtifactPath,
        expected: {
          ...artifact.metadata,
          stripTool: manifest.stripTool,
          stripArgv: manifest.stripArgv,
          stripConfig: manifest.stripConfig,
        },
      });
      if (replay.replayedStrip !== true || replay.manifestDigest !== manifest.manifestDigest) {
        throw new Error(`twin-replay-incomplete:${artifact.id}`);
      }
      captured.push(Object.freeze({
        id: artifact.id,
        debugArtifactPath: artifact.path,
        strippedArtifactPath,
        debugSidecars: Object.freeze(debugSidecars),
        manifest,
      }));
    }
  } catch (error) {
    return unavailableCapture({
      metricId,
      workloadId,
      producer,
      kind,
      status: STATUS.INVALID,
      corpusId,
      corpusVersion,
      reason: String(error?.message || error),
      errorCode: error?.code || null,
    });
  } finally {
    stripEnvironment.restore();
  }
  const identity = captureIdentity({
    metricId,
    workloadId,
    producer,
    kind,
    corpusId,
    corpusVersion,
    artifacts: captured,
  });
  if (identity.artifactIds.length !== artifacts.length || new Set(identity.artifactIds).size !== identity.artifactIds.length) {
    return unavailableCapture({
      metricId,
      workloadId,
      producer,
      kind,
      status: STATUS.INVALID,
      corpusId,
      corpusVersion,
      reason: 'artifact-denominator-invalid',
    });
  }
  const denominator = Object.freeze({
    artifactCount: identity.artifactIds.length,
    artifactIds: Object.freeze([...identity.artifactIds]),
    artifactIdsDigest: identity.artifactIdsDigest,
  });
  const digest = captureDigest(identity);
  const truthBinding = unmeasuredTruthBinding({ metricId, workloadId, corpusId, corpusVersion, identity });
  return Object.freeze({
    schemaVersion: COMPETITIVE_TWIN_CAPTURE_SCHEMA,
    metricId,
    workloadId,
    producer,
    kind,
    status: STATUS.READY,
    corpusId,
    corpusVersion,
    denominator,
    identity: Object.freeze({ ...identity, artifacts: Object.freeze(identity.artifacts) }),
    captureDigest: digest,
    truthBinding,
    measurement: emptyMeasurement(productionArtifactObservation(captured)),
    artifacts: Object.freeze(captured),
  });
}

function captureValidationError(code, detail = '') {
  throw new TypeError(`competitive-twin-capture-${code}${detail ? `:${detail}` : ''}`);
}

/**
 * Validate a capture record and, by default, replay every recorded strip
 * operation.  A capture digest is derived from manifest identities only; it
 * never includes host-local paths or wall-clock fields.  `replayArtifacts:
 * false` is available for an offline shape/digest check after run artifacts
 * have been archived, but it cannot establish current byte evidence.
 */
export function validateCompetitiveTwinCapture(capture, { replayArtifacts = true, expectedMetricId = null } = {}) {
  if (capture == null || typeof capture !== 'object' || Array.isArray(capture)) captureValidationError('object-required');
  if (capture.schemaVersion !== COMPETITIVE_TWIN_CAPTURE_SCHEMA) captureValidationError('schema-version');
  if (expectedMetricId != null && capture.metricId !== expectedMetricId) captureValidationError('metric-mismatch', capture.metricId);
  if (typeof capture.metricId !== 'string' || !capture.metricId.trim()) captureValidationError('metric-id');
  if (typeof capture.workloadId !== 'string' || !capture.workloadId.trim()) captureValidationError('workload-id');
  if (![STATUS.READY, STATUS.BLOCKED_TOOLCHAIN, STATUS.NOT_INTEGRATED, STATUS.INVALID].includes(capture.status)) {
    captureValidationError('status', String(capture.status));
  }
  if (!Array.isArray(capture.artifacts)) captureValidationError('artifacts-array');
  if (capture.status !== STATUS.READY) {
    if (capture.artifacts.length !== 0) captureValidationError('unavailable-artifacts');
    if (capture.measurement?.status !== MEASUREMENT_STATUS
      || capture.measurement.candidateValue !== null
      || capture.measurement.referenceValue !== null
      || capture.measurement.comparison !== MEASUREMENT_STATUS) {
      captureValidationError('unavailable-measurement');
    }
    return Object.freeze({ verified: true, status: capture.status, artifactCount: 0, captureDigest: null });
  }
  if (!capture.identity || typeof capture.identity !== 'object') captureValidationError('identity-required');
  if (capture.producer !== capture.identity.producer || capture.kind !== capture.identity.kind) captureValidationError('producer-identity');
  if (!capture.denominator || typeof capture.denominator !== 'object') captureValidationError('denominator-required');
  if (!capture.truthBinding || capture.truthBinding.schemaVersion !== COMPETITIVE_TWIN_TRUTH_SCHEMA) captureValidationError('truth-binding-required');
  if (capture.truthBinding.authority !== TRUTH_AUTHORITY || capture.truthBinding.status !== MEASUREMENT_STATUS) captureValidationError('truth-binding-status');
  if (capture.truthBinding.competitorOutputIsNeverAuthority !== true) captureValidationError('competitor-authority-policy');
  if (capture.measurement?.status !== MEASUREMENT_STATUS
    || capture.measurement.candidateValue !== null
    || capture.measurement.referenceValue !== null
    || capture.measurement.comparison !== MEASUREMENT_STATUS) {
    captureValidationError('measurement-must-remain-unmeasured');
  }
  const productionObservation = capture.measurement.productionObservation;
  if (productionObservation == null || productionObservation.artifactCount !== capture.artifacts.length
      || !Number.isSafeInteger(productionObservation.debugBytes)
      || !Number.isSafeInteger(productionObservation.strippedBytes)
      || !Array.isArray(productionObservation.rows)
      || productionObservation.rows.length !== capture.artifacts.length
      || productionObservation.digest !== stableDigest(productionObservation.rows)) {
    captureValidationError('production-observation');
  }
  if (!Number.isSafeInteger(capture.denominator.artifactCount) || capture.denominator.artifactCount !== capture.artifacts.length) {
    captureValidationError('denominator-count');
  }
  const ids = capture.artifacts.map((artifact) => artifact?.id);
  if (ids.some((id) => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) captureValidationError('artifact-ids');
  if (capture.denominator.artifactIdsDigest !== stableDigest([...ids].sort((left, right) => left.localeCompare(right)))) {
    captureValidationError('denominator-digest');
  }
  const expectedIdentity = captureIdentity({
    metricId: capture.metricId,
    workloadId: capture.workloadId,
    producer: capture.identity.producer,
    kind: capture.identity.kind,
    corpusId: capture.corpusId,
    corpusVersion: capture.corpusVersion,
    artifacts: capture.artifacts,
  });
  if (stableDigest(capture.identity) !== stableDigest(expectedIdentity)) captureValidationError('identity-digest');
  if (capture.captureDigest !== captureDigest(expectedIdentity)) captureValidationError('capture-digest');
  if (capture.truthBinding.metricId !== capture.metricId
      || capture.truthBinding.workloadId !== capture.workloadId
      || capture.truthBinding.corpusId !== capture.corpusId
      || capture.truthBinding.corpusVersion !== capture.corpusVersion) {
    captureValidationError('truth-binding-identity');
  }
  const expectedManifestDigests = expectedIdentity.artifacts.map((artifact) => artifact.manifestDigest);
  if (stableDigest(capture.truthBinding.manifestDigests) !== stableDigest(expectedManifestDigests)) captureValidationError('truth-binding-manifests');
  for (const artifact of capture.artifacts) {
    if (artifact == null || typeof artifact !== 'object' || artifact.manifest == null) captureValidationError('artifact-manifest', String(artifact?.id));
    const sidecars = artifact.debugSidecars ?? [];
    if (!Array.isArray(sidecars)) captureValidationError('debug-sidecars-array', artifact.id);
    const expectedSidecars = artifact.manifest.compileOptions?.debugSidecar == null
      ? []
      : [artifact.manifest.compileOptions.debugSidecar];
    const actualSidecars = sidecars.map((sidecar) => ({ id: sidecar?.id, sha256: sidecar?.sha256 }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const normalizedExpectedSidecars = expectedSidecars.map((sidecar) => ({ id: sidecar?.id, sha256: sidecar?.sha256 }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    if (stableDigest(actualSidecars) !== stableDigest(normalizedExpectedSidecars)) captureValidationError('debug-sidecar-identity', artifact.id);
    if (replayArtifacts) {
      try {
        for (const sidecar of sidecars) {
          if (typeof sidecar?.path !== 'string' || !fs.existsSync(sidecar.path)
              || typeof sidecar.sha256 !== 'string' || sha256File(sidecar.path) !== sidecar.sha256) {
            captureValidationError('debug-sidecar-invalid', `${artifact.id}:${sidecar?.id}`);
          }
        }
        const replay = validateTwinManifest(artifact.manifest, {
          debugArtifactPath: artifact.debugArtifactPath,
          strippedArtifactPath: artifact.strippedArtifactPath,
          expected: artifact.manifest,
        });
        if (replay.replayedStrip !== true || replay.manifestDigest !== artifact.manifest.manifestDigest) {
          captureValidationError('artifact-replay', artifact.id);
        }
        const row = productionObservation.rows.find((candidate) => candidate.id === artifact.id);
        if (row == null || row.debugBytes !== fs.statSync(artifact.debugArtifactPath).size
            || row.strippedBytes !== fs.statSync(artifact.strippedArtifactPath).size
            || row.debugArtifactSha256 !== artifact.manifest.debugArtifactSha256
            || row.strippedArtifactSha256 !== artifact.manifest.strippedArtifactSha256
            || stableDigest(row.debugSidecars || []) !== stableDigest((artifact.debugSidecars || [])
              .map((sidecar) => ({ id: sidecar.id, sha256: sidecar.sha256 }))
              .sort((left, right) => left.id.localeCompare(right.id)))) {
          captureValidationError('production-observation-mismatch', artifact.id);
        }
      } catch (error) {
        captureValidationError('artifact-invalid', `${artifact.id}:${error.message}`);
      }
    } else {
      try { validateTwinManifest(artifact.manifest); } catch (error) { captureValidationError('artifact-invalid', `${artifact.id}:${error.message}`); }
    }
  }
  const expectedDebugBytes = productionObservation.rows.reduce((sum, row) => sum + row.debugBytes, 0);
  const expectedStrippedBytes = productionObservation.rows.reduce((sum, row) => sum + row.strippedBytes, 0);
  if (productionObservation.debugBytes !== expectedDebugBytes || productionObservation.strippedBytes !== expectedStrippedBytes) {
    captureValidationError('production-observation-total');
  }
  return Object.freeze({
    verified: true,
    status: capture.status,
    artifactCount: capture.artifacts.length,
    artifactIdsDigest: capture.denominator.artifactIdsDigest,
    captureDigest: capture.captureDigest,
  });
}

export function writeCompetitiveTwinCapture(capture, outputPath) {
  validateCompetitiveTwinCapture(capture, { replayArtifacts: false });
  if (typeof outputPath !== 'string' || !outputPath.trim()) captureValidationError('output-path');
  const resolved = path.resolve(outputPath);
  const parent = path.dirname(resolved);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = path.join(parent, `.${path.basename(resolved)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(capture, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, resolved);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return resolved;
}

export function loadCompetitiveTwinCapture(inputPath, options = {}) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) captureValidationError('input-path');
  let capture;
  try { capture = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8')); } catch { captureValidationError('json-invalid'); }
  validateCompetitiveTwinCapture(capture, options);
  return capture;
}

function blockedCapture(metricId, workloadId, code, error, { producer = null, kind = null, details = null } = {}) {
  return unavailableCapture({
    metricId,
    workloadId,
    producer,
    kind,
    status: code === 'TOOLCHAIN' ? STATUS.BLOCKED_TOOLCHAIN : STATUS.NOT_INTEGRATED,
    reason: String(error?.message || error || 'unavailable'),
    errorCode: error?.code || null,
    details,
  });
}

export function capturePhase5TwinWorkload({ metricId = 'machine-effects-x86_64-coverage', artifactRoot, outDir, toolchainBin = process.env.HEX_P56_TOOLCHAIN_BIN || null } = {}) {
  const spec = COMPETITIVE_TWIN_WORKLOADS[metricId];
  if (!spec || spec.workloadId !== 'phase5-p5-6-generated-corpus') throw new TypeError(`unknown-phase5-twin-workload:${metricId}`);
  const root = artifactRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'hex-competitive-p5-twins-'));
  try {
    const corpus = buildVerificationCorpus({ outDir: outDir || path.join(root, 'debug'), toolchainBin, debug: true });
    return captureTwinArtifacts({
      metricId,
      workloadId: spec.workloadId,
      producer: spec.producer,
      kind: spec.kind,
      corpusId: 'phase5-p5-6-generated-corpus',
      corpusVersion: 1,
      artifactRoot: root,
      artifacts: corpus.fixtures.map((fixture) => ({
        id: fixture.id,
        path: fixture.path,
        metadata: phase5Metadata(corpus, fixture),
        debugSidecars: (() => {
          const sidecarPath = debugSidecarPathForFixture(fixture);
          return sidecarPath == null ? [] : [{ id: 'pdb', path: sidecarPath, sha256: sha256File(sidecarPath) }];
        })(),
      })),
    });
  } catch (error) {
    return blockedCapture(metricId, spec.workloadId, error?.code === 'P5_6_TOOLCHAIN_MISMATCH' ? 'TOOLCHAIN' : 'INTEGRATED', error, spec);
  }
}

export function capturePhase6TwinWorkload({ metricId = 'machine-effects-riscv64-coverage', artifactRoot, outDir, toolchainBin = process.env.HEX_P56_TOOLCHAIN_BIN || null } = {}) {
  const spec = COMPETITIVE_TWIN_WORKLOADS[metricId];
  if (!spec || spec.workloadId !== 'phase6-riscv64-generated-corpus') throw new TypeError(`unknown-phase6-twin-workload:${metricId}`);
  const root = artifactRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'hex-competitive-p6-twins-'));
  try {
    const corpus = buildPhase6VerificationCorpus({ outDir: outDir || path.join(root, 'debug'), toolchainBin, debug: true });
    return captureTwinArtifacts({
      metricId,
      workloadId: spec.workloadId,
      producer: spec.producer,
      kind: spec.kind,
      corpusId: corpus.corpusId,
      corpusVersion: 1,
      artifactRoot: root,
      stripTool: 'llvm-strip',
      stripCandidates: [
        process.env.HEX_COMPETITIVE_LLVM_STRIP,
        ...(toolchainBin == null ? [] : [path.join(toolchainBin, '..', 'root', 'usr', 'bin', 'llvm-strip-18')]),
      ].filter(Boolean),
      artifacts: corpus.fixtures.map((fixture) => ({ id: fixture.id, path: fixture.path, metadata: phase6Metadata(corpus, fixture) })),
    });
  } catch (error) {
    return blockedCapture(metricId, spec.workloadId, error?.code === 'P6_TOOLCHAIN_MISMATCH' ? 'TOOLCHAIN' : 'INTEGRATED', error, spec);
  }
}

export function capturePhase8TwinWorkload({ metricId = 'decompiler-quality-gotos', artifactRoot, artifactDirectory, clang = process.env.CLANG || 'clang', expectedCompilerVersion = EXPECTED_PHASE8_COMPILER_VERSION, nativeArm64 = true } = {}) {
  const spec = COMPETITIVE_TWIN_WORKLOADS[metricId];
  if (!spec || spec.workloadId !== 'phase8-decompiler-quality-corpus') throw new TypeError(`unknown-phase8-twin-workload:${metricId}`);
  const root = artifactRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'hex-competitive-p8-twins-'));
  const outputDirectory = artifactDirectory || path.join(root, 'debug');
  try {
    const corpus = buildPhase8Corpus({ clang, artifactDirectory: outputDirectory, debug: true });
    if (expectedCompilerVersion && !String(corpus.toolchain.compiler).includes(expectedCompilerVersion)) {
      const error = new Error(`phase8-compiler-identity-mismatch:${firstLine(corpus.toolchain.compiler)}!=${expectedCompilerVersion}`);
      error.code = 'P8_TOOLCHAIN_MISMATCH';
      throw error;
    }
    const nativeArtifacts = nativeArm64
      ? buildPhase8NativeArm64Artifacts({ clang, artifactDirectory: path.join(outputDirectory, 'arm64-native') })
      : [];
    const allArtifacts = [...corpus.artifacts, ...nativeArtifacts];
    const sourceByName = new Map();
    for (const sourceName of new Set(allArtifacts.map((artifact) => artifact.source))) {
      const sourcePath = path.join(PHASE8_SOURCE_DIRECTORY, sourceName);
      sourceByName.set(sourceName, { path: path.relative(ROOT, sourcePath).replaceAll('\\', '/'), sha256: sha256File(sourcePath) });
    }
    return captureTwinArtifacts({
      metricId,
      workloadId: spec.workloadId,
      producer: spec.producer,
      kind: spec.kind,
      corpusId: corpus.corpusId,
      corpusVersion: corpus.corpusVersion,
      artifactRoot: root,
      stripTool: 'llvm-strip',
      stripCandidates: [
        process.env.HEX_COMPETITIVE_LLVM_STRIP,
        path.join(path.dirname(clang), '..', 'root', 'usr', 'bin', 'llvm-strip-18'),
      ].filter(Boolean),
      artifacts: allArtifacts.map((artifact) => ({
        id: artifact.id,
        path: artifact.path,
        metadata: phase8Metadata(corpus, artifact, clang, sourceByName.get(artifact.source)),
      })),
    });
  } catch (error) {
    return blockedCapture(metricId, spec.workloadId, error?.code === 'P8_TOOLCHAIN_MISMATCH' ? 'TOOLCHAIN' : 'INTEGRATED', error, spec);
  }
}

/**
 * Inspect the repository-owned benchmark fixture inputs without treating the
 * pinned binary hashes or loader observations as compiler/debug provenance.
 * A producer may provide `tests/fixtures/real-binary-twin-identity.json`
 * (or `HEX_COMPETITIVE_BENCHMARK_IDENTITY`) with one metadata-bearing debug
 * artifact per pinned fixture. Missing rows stay explicit and cannot enter a
 * score as measured data.
 */
export function inspectBenchmarkTwinInputs({
  fixtureManifestPath = BENCHMARK_FIXTURE_MANIFEST_PATH,
  fixtureDirectory = BENCHMARK_FIXTURE_DIRECTORY,
  identityManifestPath = process.env.HEX_COMPETITIVE_BENCHMARK_IDENTITY || BENCHMARK_IDENTITY_MANIFEST_PATH,
} = {}) {
  const result = {
    schemaVersion: 'hex-competitive-benchmark-identity/v1',
    status: 'NOT-INTEGRATED',
    fixtureManifestPath: relativeIdentity(fixtureManifestPath),
    fixtureDirectory: relativeIdentity(fixtureDirectory),
    identityManifestPath: identityManifestPath == null ? null : relativeIdentity(identityManifestPath),
    fixtureCount: 0,
    rows: [],
    missing: [],
  };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(fixtureManifestPath, 'utf8'));
  } catch (error) {
    result.missing.push({ fixtureId: null, code: 'fixture-manifest-unavailable', detail: String(error?.message || error) });
    result.status = 'INVALID';
    return Object.freeze(result);
  }
  let identityManifest = null;
  if (identityManifestPath != null) {
    try {
      identityManifest = JSON.parse(fs.readFileSync(identityManifestPath, 'utf8'));
    } catch (error) {
      result.missing.push({ fixtureId: null, code: 'identity-manifest-unavailable', detail: String(error?.message || error) });
    }
  } else {
    result.missing.push({ fixtureId: null, code: 'identity-manifest-not-configured' });
  }
  const fixtureEntries = Object.entries(manifest?.fixtures || {});
  result.fixtureCount = fixtureEntries.length;
  if (fixtureEntries.length === 0) {
    result.missing.push({ fixtureId: null, code: 'fixture-manifest-empty' });
    result.status = 'INVALID';
    return Object.freeze(result);
  }
  let invalid = false;
  for (const [fixtureId, spec] of fixtureEntries) {
    const missing = [];
    const fixturePath = path.resolve(fixtureDirectory, spec?.file || '');
    let fixtureStatus = 'READY';
    if (!spec || typeof spec.file !== 'string' || !spec.file.trim()) {
      missing.push('fixture-file-name');
      fixtureStatus = 'INVALID';
    } else if (!fs.existsSync(fixturePath)) {
      missing.push('pinned-fixture-file');
    } else {
      try {
        const observed = { size: fs.statSync(fixturePath).size, sha256: sha256File(fixturePath) };
        if (observed.size !== spec.size || observed.sha256 !== spec.sha256) {
          missing.push('pinned-fixture-digest-mismatch');
          fixtureStatus = 'INVALID';
        }
      } catch (error) {
        missing.push(`pinned-fixture-read:${String(error?.message || error)}`);
        fixtureStatus = 'INVALID';
      }
    }
    const identityEntry = identityManifest?.fixtures?.[fixtureId];
    const metadata = identityEntry?.metadata && typeof identityEntry.metadata === 'object'
      ? identityEntry.metadata
      : null;
    if (identityEntry == null) {
      missing.push('source-compiler-debug-identity');
    } else {
      const debugArtifactPath = identityEntry.debugArtifactPath;
      if (typeof debugArtifactPath !== 'string' || !debugArtifactPath.trim()) {
        missing.push('debug-artifact-path');
      } else if (!fs.existsSync(path.resolve(ROOT, debugArtifactPath))) {
        missing.push('debug-artifact-file');
      }
      if (metadata == null) {
        missing.push('twin-metadata');
      } else {
        for (const field of ['corpusId', 'corpusVersion', 'sourceIdentity', 'compiler', 'targetTriple', 'architecture', 'profile', 'compileArgs', 'compileOptions', 'linker', 'buildIdentity']) {
          if (!Object.prototype.hasOwnProperty.call(metadata, field)) missing.push(`metadata-${field}`);
        }
        if (metadata.compileOptions?.debug !== true) missing.push('metadata-debug-build');
        if (!Array.isArray(metadata.compileArgs) || !metadata.compileArgs.includes('-g')) missing.push('metadata-debug-flag');
      }
    }
    if (missing.length > 0) {
      if (fixtureStatus !== 'INVALID') fixtureStatus = 'MISSING';
      result.missing.push(...missing.map((code) => ({ fixtureId, code })));
    }
    if (fixtureStatus === 'INVALID') invalid = true;
    result.rows.push({
      fixtureId,
      file: spec?.file || null,
      path: relativeIdentity(fixturePath),
      expectedSize: Number.isSafeInteger(spec?.size) ? spec.size : null,
      expectedSha256: typeof spec?.sha256 === 'string' ? spec.sha256 : null,
      status: fixtureStatus,
      missing: [...missing],
      ...(identityEntry == null ? {} : {
        debugArtifactPath: typeof identityEntry.debugArtifactPath === 'string'
          ? relativeIdentity(path.resolve(ROOT, identityEntry.debugArtifactPath))
          : null,
        debugArtifactResolvedPath: typeof identityEntry.debugArtifactPath === 'string'
          ? path.resolve(ROOT, identityEntry.debugArtifactPath)
          : null,
        metadata,
      }),
    });
  }
  result.status = invalid ? 'INVALID' : (result.missing.length === 0 ? 'READY' : 'NOT-INTEGRATED');
  return Object.freeze(result);
}

export function captureBenchmarkTwinWorkload({
  metricId = 'universal-binary-hotpath-ms',
  artifactRoot,
  fixtureManifestPath,
  fixtureDirectory,
  identityManifestPath,
  stripTool = 'llvm-strip',
  stripCandidates = [],
} = {}) {
  const spec = COMPETITIVE_TWIN_WORKLOADS[metricId];
  if (!spec || spec.kind !== 'benchmark-binary') throw new TypeError(`unknown-benchmark-twin-workload:${metricId}`);
  const inspection = inspectBenchmarkTwinInputs({ fixtureManifestPath, fixtureDirectory, identityManifestPath });
  if (inspection.status !== 'READY') {
    return blockedCapture(
      metricId,
      spec.workloadId,
      inspection.status === 'INVALID' ? 'INTEGRATED' : 'INTEGRATED',
      new Error(`benchmark-baseline-source-and-debug-artifact-identity-missing:${inspection.missing.map((entry) => `${entry.fixtureId || 'manifest'}:${entry.code}`).join(',')}`),
      { ...spec, details: { benchmarkIdentity: inspection } },
    );
  }
  const root = artifactRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'hex-competitive-benchmark-twins-'));
  const rows = inspection.rows;
  const metadataRows = rows.map((row) => ({
    id: row.fixtureId,
    path: row.debugArtifactResolvedPath,
    metadata: row.metadata,
  }));
  const corpusIds = new Set(metadataRows.map((row) => row.metadata.corpusId));
  const corpusVersions = new Set(metadataRows.map((row) => row.metadata.corpusVersion));
  if (corpusIds.size !== 1 || corpusVersions.size !== 1) {
    return blockedCapture(metricId, spec.workloadId, 'INTEGRATED', new Error('benchmark-twin-corpus-identity-mismatch'), {
      ...spec,
      details: { benchmarkIdentity: inspection },
    });
  }
  const capture = captureTwinArtifacts({
    metricId,
    workloadId: spec.workloadId,
    producer: spec.producer,
    kind: spec.kind,
    corpusId: metadataRows[0].metadata.corpusId,
    corpusVersion: metadataRows[0].metadata.corpusVersion,
    artifactRoot: root,
    stripTool,
    stripCandidates,
    artifacts: metadataRows,
  });
  if (capture.status !== STATUS.READY) return capture;
  for (const artifact of capture.artifacts) {
    const expected = rows.find((row) => row.fixtureId === artifact.id);
    const actualSize = fs.statSync(artifact.strippedArtifactPath).size;
    if (expected == null || artifact.manifest.strippedArtifactSha256 !== expected.expectedSha256 || actualSize !== expected.expectedSize) {
      return blockedCapture(metricId, spec.workloadId, 'INTEGRATED', new Error(`benchmark-twin-stripped-fixture-mismatch:${artifact.id}`), {
        ...spec,
        details: { benchmarkIdentity: inspection },
      });
    }
  }
  return capture;
}

export function captureCompetitiveTwinWorkload(metricId, options = {}) {
  if (!Object.prototype.hasOwnProperty.call(COMPETITIVE_TWIN_WORKLOADS, metricId)) throw new TypeError(`competitive-twin-workload-unknown:${metricId}`);
  const spec = COMPETITIVE_TWIN_WORKLOADS[metricId];
  if (spec.workloadId === 'phase5-p5-6-generated-corpus') return capturePhase5TwinWorkload({ ...options, metricId });
  if (spec.workloadId === 'phase6-riscv64-generated-corpus') return capturePhase6TwinWorkload({ ...options, metricId });
  if (spec.workloadId === 'phase8-decompiler-quality-corpus') return capturePhase8TwinWorkload({ ...options, metricId });
  return captureBenchmarkTwinWorkload({ ...options, metricId });
}

export function competitiveTwinWorkloadFor(metricId) {
  const spec = COMPETITIVE_TWIN_WORKLOADS[metricId];
  return spec == null ? null : Object.freeze({ metricId, ...spec });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const metricIds = requested.length ? requested : Object.keys(COMPETITIVE_TWIN_WORKLOADS);
  const output = [];
  for (const metricId of metricIds) {
    const capture = captureCompetitiveTwinWorkload(metricId, {
      expectedCompilerVersion: process.env.HEX_COMPETITIVE_PHASE8_COMPILER_VERSION || EXPECTED_PHASE8_COMPILER_VERSION,
    });
    output.push({
      metricId,
      workloadId: capture.workloadId,
      status: capture.status,
      artifactCount: capture.denominator?.artifactCount ?? capture.artifacts.length,
      artifactIdsDigest: capture.denominator?.artifactIdsDigest ?? null,
      captureDigest: capture.captureDigest ?? null,
      reason: capture.reason || null,
    });
  }
  process.stdout.write(`${JSON.stringify({ schemaVersion: COMPETITIVE_TWIN_CAPTURE_SCHEMA, captures: output })}\n`);
  if (output.some((entry) => entry.status !== STATUS.READY)) process.exitCode = 2;
}
