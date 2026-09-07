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

export const COMPETITIVE_TWIN_CAPTURE_SCHEMA = 'hex-competitive-twin-capture/v1';

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

function phase5Metadata(corpus, fixture) {
  const source = sourceIdentity(corpus.source);
  const supportSource = sourceIdentity(corpus.supportSource);
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
      optimization: fixture.optimization,
      supportSource,
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
      optimization: artifact.optimization,
      representation: 'machine-bytes',
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

export function captureTwinArtifacts({ metricId, workloadId, corpusId, corpusVersion, artifactRoot, artifacts, stripTool = 'strip', stripCandidates = [] }) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return Object.freeze({
      schemaVersion: COMPETITIVE_TWIN_CAPTURE_SCHEMA,
      metricId,
      workloadId,
      status: STATUS.NOT_INTEGRATED,
      corpusId,
      corpusVersion,
      artifacts: [],
      reason: 'no-debug-artifacts-produced',
    });
  }
  const captured = [];
  const stripEnvironment = stripToolEnvironment(artifactRoot, stripTool, stripCandidates);
  if (!stripEnvironment) {
    return Object.freeze({
      schemaVersion: COMPETITIVE_TWIN_CAPTURE_SCHEMA,
      metricId,
      workloadId,
      status: STATUS.BLOCKED_TOOLCHAIN,
      corpusId,
      corpusVersion,
      artifacts: [],
      reason: `${stripTool}-unavailable`,
    });
  }
  try {
    for (const artifact of artifacts) {
      if (!artifact?.path || !fs.existsSync(artifact.path)) throw new Error(`artifact-missing:${artifact?.id || 'unknown'}`);
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
        manifest,
      }));
    }
  } catch (error) {
    return Object.freeze({
      schemaVersion: COMPETITIVE_TWIN_CAPTURE_SCHEMA,
      metricId,
      workloadId,
      status: STATUS.INVALID,
      corpusId,
      corpusVersion,
      artifacts: [],
      reason: String(error?.message || error),
    });
  } finally {
    stripEnvironment.restore();
  }
  return Object.freeze({
    schemaVersion: COMPETITIVE_TWIN_CAPTURE_SCHEMA,
    metricId,
    workloadId,
    status: STATUS.READY,
    corpusId,
    corpusVersion,
    artifacts: Object.freeze(captured),
  });
}

function blockedCapture(metricId, workloadId, code, error) {
  return Object.freeze({
    schemaVersion: COMPETITIVE_TWIN_CAPTURE_SCHEMA,
    metricId,
    workloadId,
    status: code === 'TOOLCHAIN' ? STATUS.BLOCKED_TOOLCHAIN : STATUS.NOT_INTEGRATED,
    corpusId: null,
    corpusVersion: null,
    artifacts: [],
    reason: String(error?.message || error || 'unavailable'),
    errorCode: error?.code || null,
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
      corpusId: 'phase5-p5-6-generated-corpus',
      corpusVersion: 1,
      artifactRoot: root,
      artifacts: corpus.fixtures.map((fixture) => ({ id: fixture.id, path: fixture.path, metadata: phase5Metadata(corpus, fixture) })),
    });
  } catch (error) {
    return blockedCapture(metricId, spec.workloadId, error?.code === 'P5_6_TOOLCHAIN_MISMATCH' ? 'TOOLCHAIN' : 'INTEGRATED', error);
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
    return blockedCapture(metricId, spec.workloadId, error?.code === 'P6_TOOLCHAIN_MISMATCH' ? 'TOOLCHAIN' : 'INTEGRATED', error);
  }
}

export function capturePhase8TwinWorkload({ metricId = 'decompiler-quality-gotos', artifactRoot, artifactDirectory, clang = process.env.CLANG || 'clang', expectedCompilerVersion = EXPECTED_PHASE8_COMPILER_VERSION } = {}) {
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
    const sourceByName = new Map();
    for (const sourceName of new Set(corpus.artifacts.map((artifact) => artifact.source))) {
      const sourcePath = path.join(PHASE8_SOURCE_DIRECTORY, sourceName);
      sourceByName.set(sourceName, { path: path.relative(ROOT, sourcePath).replaceAll('\\', '/'), sha256: sha256File(sourcePath) });
    }
    return captureTwinArtifacts({
      metricId,
      workloadId: spec.workloadId,
      corpusId: corpus.corpusId,
      corpusVersion: corpus.corpusVersion,
      artifactRoot: root,
      stripTool: 'llvm-strip',
      stripCandidates: [
        process.env.HEX_COMPETITIVE_LLVM_STRIP,
        path.join(path.dirname(clang), '..', 'root', 'usr', 'bin', 'llvm-strip-18'),
      ].filter(Boolean),
      artifacts: corpus.artifacts.map((artifact) => ({
        id: artifact.id,
        path: artifact.path,
        metadata: phase8Metadata(corpus, artifact, clang, sourceByName.get(artifact.source)),
      })),
    });
  } catch (error) {
    return blockedCapture(metricId, spec.workloadId, error?.code === 'P8_TOOLCHAIN_MISMATCH' ? 'TOOLCHAIN' : 'INTEGRATED', error);
  }
}

/**
 * The benchmark baseline names downloaded binaries and measured loader work,
 * but it has no source/compiler identity and no debug-bearing artifact. It is
 * therefore intentionally explicit until a producer supplies both.
 */
export function captureBenchmarkTwinWorkload({ metricId = 'universal-binary-hotpath-ms' } = {}) {
  const spec = COMPETITIVE_TWIN_WORKLOADS[metricId];
  if (!spec || spec.kind !== 'benchmark-binary') throw new TypeError(`unknown-benchmark-twin-workload:${metricId}`);
  return blockedCapture(metricId, spec.workloadId, 'INTEGRATED', new Error('benchmark-baseline-source-and-debug-artifact-identity-missing'));
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
    output.push({ metricId, workloadId: capture.workloadId, status: capture.status, artifactCount: capture.artifacts.length, reason: capture.reason || null });
  }
  process.stdout.write(`${JSON.stringify({ schemaVersion: COMPETITIVE_TWIN_CAPTURE_SCHEMA, captures: output })}\n`);
  if (output.some((entry) => entry.status !== STATUS.READY)) process.exitCode = 2;
}
