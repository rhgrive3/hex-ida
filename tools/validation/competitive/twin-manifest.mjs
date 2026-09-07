/**
 * Same-binary debug/stripped twin provenance.
 *
 * A twin is not established by two matching metadata records.  The generator
 * starts with one debug-bearing artifact, copies that artifact, and applies a
 * single allowlisted strip operation to the copy.  Validation repeats that
 * operation from the supplied debug artifact and compares the resulting bytes
 * with the supplied stripped artifact.  This keeps a post-build patch, a
 * separately compiled "twin", and a stale toolchain manifest out of the
 * competitive truth path.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { stableDigest, stableStringify } from '../../../js/core/identity/index.js';

export const TWIN_MANIFEST_SCHEMA_VERSION = 'hex-competitive-twin-manifest/v1';
export const TWIN_LINEAGE_RELATION = 'debug-artifact-strip-only';
export const TWIN_STRIP_MODE = 'debug-only';

/**
 * The executable id is deliberately an id, rather than an arbitrary path.
 * Paths are environment-local and would make both replay and identity
 * ambiguous.  The validator resolves these ids through the current PATH and
 * also requires the observed version to match the manifest.
 */
export const RECOGNIZED_STRIP_TOOLS = Object.freeze({
  strip: Object.freeze({ versionArgs: Object.freeze(['--version']) }),
  'llvm-strip': Object.freeze({ versionArgs: Object.freeze(['--version']) }),
});

export const RECOGNIZED_STRIP_ARGV = Object.freeze(['--strip-debug']);
export const RECOGNIZED_STRIP_CONFIG = Object.freeze({
  mode: TWIN_STRIP_MODE,
  inPlace: true,
});

const TOP_LEVEL_KEYS = Object.freeze([
  'schemaVersion',
  'corpusId',
  'corpusVersion',
  'sourceIdentity',
  'compiler',
  'targetTriple',
  'architecture',
  'profile',
  'compileArgs',
  'compileOptions',
  'linker',
  'buildIdentity',
  'debugArtifactSha256',
  'stripTool',
  'stripArgv',
  'stripConfig',
  'strippedArtifactSha256',
  'lineage',
  'manifestDigest',
]);

const BODY_KEYS = Object.freeze(TOP_LEVEL_KEYS.filter((key) => key !== 'manifestDigest'));
const SOURCE_KEYS = Object.freeze(['id', 'sha256']);
const TOOL_KEYS = Object.freeze(['id', 'version']);
const ARCHITECTURE_KEYS = Object.freeze(['id', 'profile']);
const LINKER_KEYS = Object.freeze(['id', 'version', 'options']);
const LINEAGE_KEYS = Object.freeze([
  'relation',
  'immutable',
  'sourceArtifactSha256',
  'strippedArtifactSha256',
]);

const SHA256_RE = /^[0-9a-f]{64}$/;
const DIGEST_RE = /^[0-9a-f]{32}$/;
const ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:[\\/]|[\\/]\\|[\\/]|\\\\)/;
const ISO_TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/;
const NONDETERMINISTIC_KEY_RE = /(?:^|[-_])(absolute|timestamp|generated.?at|temp(?:orary)?|cwd|working.?directory|output.?path|source.?path)(?:$|[-_])/i;

function fail(code, detail = '') {
  const suffix = detail ? `:${detail}` : '';
  throw new TypeError(`twin-manifest-${code}${suffix}`);
}

function assertPlainObject(value, code) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
}

function assertExactKeys(value, allowed, code) {
  assertPlainObject(value, code);
  const expected = new Set(allowed);
  for (const key of Object.keys(value)) if (!expected.has(key)) fail(`${code}-unknown-field`, key);
  for (const key of allowed) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${code}-missing-field`, key);
}

function text(value, code, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') fail(code);
  const normalized = value.trim();
  if (!allowEmpty && !normalized) fail(code);
  if (normalized.includes('\u0000')) fail(`${code}-nul`);
  if (ISO_TIMESTAMP_RE.test(normalized)) fail(`${code}-timestamp`);
  return normalized;
}

function safeIdentityText(value, code) {
  const normalized = text(value, code);
  if (ABSOLUTE_PATH_RE.test(normalized) || normalized.includes('\\')) fail(`${code}-path`);
  return normalized;
}

function sha256(value, code = 'sha256') {
  const normalized = text(value, code).toLowerCase().replace(/^sha256:/, '');
  if (!SHA256_RE.test(normalized)) fail(`${code}-invalid`);
  return normalized;
}

export function sha256Bytes(value) {
  let bytes;
  if (Buffer.isBuffer(value)) bytes = value;
  else if (value instanceof Uint8Array) bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  else if (value instanceof ArrayBuffer) bytes = Buffer.from(value);
  else fail('bytes-required');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(filePath) {
  const resolved = requireFilePath(filePath, 'artifact');
  return sha256Bytes(fs.readFileSync(resolved));
}

function requireFilePath(filePath, code) {
  if (typeof filePath !== 'string' || !filePath.trim()) fail(`${code}-path-required`);
  const resolved = path.resolve(filePath);
  let stat;
  try { stat = fs.statSync(resolved); } catch { fail(`${code}-missing`); }
  if (!stat.isFile()) fail(`${code}-not-file`);
  return resolved;
}

function rejectNondeterministicValue(value, keyPath = '') {
  if (typeof value === 'string') {
    if (ABSOLUTE_PATH_RE.test(value) || ISO_TIMESTAMP_RE.test(value)) {
      fail('nondeterministic-value', keyPath || 'value');
    }
    return;
  }
  if (value == null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) fail('option-nonfinite', keyPath || 'value');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectNondeterministicValue(item, `${keyPath}[${index}]`));
    return;
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail('option-not-plain', keyPath || 'value');
  for (const [key, child] of Object.entries(value)) {
    if (NONDETERMINISTIC_KEY_RE.test(key)) fail('nondeterministic-field', keyPath ? `${keyPath}.${key}` : key);
    rejectNondeterministicValue(child, keyPath ? `${keyPath}.${key}` : key);
  }
}

export function normalizeCompileArgs(args, code = 'compile-args') {
  if (!Array.isArray(args)) fail(`${code}-array`);
  const normalized = args.map((arg, index) => {
    if (typeof arg !== 'string') fail(`${code}-string`, String(index));
    const value = arg.trim();
    if (!value) fail(`${code}-empty`, String(index));
    if (value.includes('\u0000') || ISO_TIMESTAMP_RE.test(value) || ABSOLUTE_PATH_RE.test(value)) fail(`${code}-nondeterministic`, String(index));
    return value;
  });
  return normalized;
}

export function normalizeCompileOptions(options, code = 'compile-options') {
  assertPlainObject(options, `${code}-object`);
  rejectNondeterministicValue(options, code);
  // stableStringify also acts as a JSON-safety check.  Parsing it back removes
  // prototypes and gives callers a deterministic, detached value.
  let normalized;
  try { normalized = JSON.parse(stableStringify(options)); } catch { fail(`${code}-not-json`); }
  if (normalized == null || typeof normalized !== 'object' || Array.isArray(normalized)) fail(`${code}-object`);
  return normalized;
}

function normalizeSourceIdentity(value) {
  assertExactKeys(value, SOURCE_KEYS, 'source-identity');
  return { id: safeIdentityText(value.id, 'source-identity-id'), sha256: sha256(value.sha256, 'source-identity-sha256') };
}

function normalizeTool(value, code) {
  assertExactKeys(value, TOOL_KEYS, code);
  const id = safeIdentityText(value.id, `${code}-id`);
  if (!Object.prototype.hasOwnProperty.call(RECOGNIZED_STRIP_TOOLS, id)) {
    // Only stripTool ids are executable.  Keeping this check here makes a
    // malformed linker/compiler object fail with its own shape check without
    // accidentally widening the strip command allowlist.
    if (code === 'strip-tool') fail('strip-tool-not-recognized', id);
  }
  return { id, version: safeIdentityText(value.version, `${code}-version`) };
}

function normalizeCompiler(value) {
  return normalizeSimpleTool(value, 'compiler');
}

function normalizeSimpleTool(value, code) {
  assertExactKeys(value, TOOL_KEYS, code);
  return { id: safeIdentityText(value.id, `${code}-id`), version: safeIdentityText(value.version, `${code}-version`) };
}

function normalizeArchitecture(value) {
  assertExactKeys(value, ARCHITECTURE_KEYS, 'architecture');
  return { id: safeIdentityText(value.id, 'architecture-id'), profile: safeIdentityText(value.profile, 'architecture-profile') };
}

function normalizeLinker(value) {
  assertExactKeys(value, LINKER_KEYS, 'linker');
  return {
    id: safeIdentityText(value.id, 'linker-id'),
    version: safeIdentityText(value.version, 'linker-version'),
    options: normalizeCompileOptions(value.options, 'linker-options'),
  };
}

function normalizeStripArgv(value) {
  const argv = normalizeCompileArgs(value, 'strip-argv');
  if (argv.length !== RECOGNIZED_STRIP_ARGV.length || argv.some((arg, index) => arg !== RECOGNIZED_STRIP_ARGV[index])) {
    fail('strip-argv-not-recognized');
  }
  return argv;
}

function normalizeStripConfig(value) {
  assertExactKeys(value, ['mode', 'inPlace'], 'strip-config');
  if (value.mode !== TWIN_STRIP_MODE || value.inPlace !== true) fail('strip-config-not-recognized');
  return { mode: TWIN_STRIP_MODE, inPlace: true };
}

function normalizeLineage(value, debugHash, strippedHash) {
  assertExactKeys(value, LINEAGE_KEYS, 'lineage');
  if (value.relation !== TWIN_LINEAGE_RELATION || value.immutable !== true) fail('lineage-not-immutable-strip-only');
  const sourceArtifactSha256 = sha256(value.sourceArtifactSha256, 'lineage-source-sha256');
  const strippedArtifactSha256 = sha256(value.strippedArtifactSha256, 'lineage-stripped-sha256');
  if (sourceArtifactSha256 !== debugHash) fail('lineage-source-mismatch');
  if (strippedArtifactSha256 !== strippedHash) fail('lineage-stripped-mismatch');
  return { relation: TWIN_LINEAGE_RELATION, immutable: true, sourceArtifactSha256, strippedArtifactSha256 };
}

function normalizeCorpusId(value) {
  return safeIdentityText(value, 'corpus-id');
}

function normalizeCorpusVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('corpus-version-invalid');
  return value;
}

function normalizeManifestBody(input) {
  assertPlainObject(input, 'manifest');
  const allowed = new Set(TOP_LEVEL_KEYS);
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail('manifest-unknown-field', key);
  for (const key of BODY_KEYS) if (!Object.prototype.hasOwnProperty.call(input, key)) fail('manifest-missing-field', key);
  if (input.schemaVersion !== TWIN_MANIFEST_SCHEMA_VERSION) fail('schema-version', String(input.schemaVersion));

  const sourceIdentity = normalizeSourceIdentity(input.sourceIdentity);
  const compiler = normalizeCompiler(input.compiler);
  const targetTriple = safeIdentityText(input.targetTriple, 'target-triple');
  const architecture = normalizeArchitecture(input.architecture);
  const profile = safeIdentityText(input.profile, 'profile');
  const compileArgs = normalizeCompileArgs(input.compileArgs);
  const compileOptions = normalizeCompileOptions(input.compileOptions);
  const linker = normalizeLinker(input.linker);
  const buildIdentity = safeIdentityText(input.buildIdentity, 'build-identity');
  const debugArtifactSha256 = sha256(input.debugArtifactSha256, 'debug-artifact-sha256');
  const stripTool = normalizeTool(input.stripTool, 'strip-tool');
  const stripArgv = normalizeStripArgv(input.stripArgv);
  const stripConfig = normalizeStripConfig(input.stripConfig);
  const strippedArtifactSha256 = sha256(input.strippedArtifactSha256, 'stripped-artifact-sha256');
  const lineage = normalizeLineage(input.lineage, debugArtifactSha256, strippedArtifactSha256);

  return {
    schemaVersion: TWIN_MANIFEST_SCHEMA_VERSION,
    corpusId: normalizeCorpusId(input.corpusId),
    corpusVersion: normalizeCorpusVersion(input.corpusVersion),
    sourceIdentity,
    compiler,
    targetTriple,
    architecture,
    profile,
    compileArgs,
    compileOptions,
    linker,
    buildIdentity,
    debugArtifactSha256,
    stripTool,
    stripArgv,
    stripConfig,
    strippedArtifactSha256,
    lineage,
  };
}

function manifestDigestForBody(body) {
  return stableDigest(body);
}

/**
 * Create a manifest from already measured byte hashes.  This pure function is
 * intentionally separate from generateTwinManifest so tests and profile
 * tooling can construct deterministic manifests without invoking a process.
 */
export function createTwinManifest(input = {}) {
  const body = normalizeManifestBody({
    ...input,
    schemaVersion: input.schemaVersion ?? TWIN_MANIFEST_SCHEMA_VERSION,
  });
  return Object.freeze({ ...body, manifestDigest: manifestDigestForBody(body) });
}

export function twinManifestDigest(manifest) {
  const body = normalizeManifestBody(manifest);
  return manifestDigestForBody(body);
}

function executableId(value) {
  if (typeof value !== 'string' || !value.trim()) fail('strip-tool-required');
  const raw = value.trim();
  const id = path.basename(raw);
  if (id !== raw && !path.isAbsolute(raw)) fail('strip-tool-path-invalid');
  if (!Object.prototype.hasOwnProperty.call(RECOGNIZED_STRIP_TOOLS, id)) fail('strip-tool-not-recognized', id);
  return id;
}

function commandVersion(id) {
  const result = spawnSync(id, [...RECOGNIZED_STRIP_TOOLS[id].versionArgs], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    shell: false,
  });
  if (result.error || result.status !== 0) fail('strip-tool-unavailable', id);
  const output = String(result.stdout || result.stderr || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!output) fail('strip-tool-version-missing', id);
  return safeIdentityText(output, 'strip-tool-version');
}

function resolveStripTool(input) {
  const raw = typeof input === 'string' ? input : input?.id;
  const id = executableId(raw ?? 'strip');
  const observedVersion = commandVersion(id);
  if (input && typeof input === 'object' && input.version != null && String(input.version).trim() !== observedVersion) {
    fail('strip-tool-version-mismatch', `${String(input.version).trim()}!=${observedVersion}`);
  }
  return { id, version: observedVersion };
}

function temporaryDirectory(prefix = 'hex-twin-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function applyRecognizedStrip({ debugArtifactPath, outputPath, stripTool }) {
  const debugPath = requireFilePath(debugArtifactPath, 'debug-artifact');
  const targetPath = path.resolve(outputPath);
  if (debugPath === targetPath) fail('debug-and-stripped-path-same');

  const workspace = temporaryDirectory();
  const replayPath = path.join(workspace, 'stripped-artifact');
  try {
    // The only input to the strip operation is this byte-for-byte copy of the
    // supplied debug artifact.  No source rebuild or second compiler run is
    // possible through this API.
    fs.copyFileSync(debugPath, replayPath);
    const result = spawnSync(stripTool.id, [...RECOGNIZED_STRIP_ARGV, '--', replayPath], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
    });
    if (result.error || result.status !== 0) {
      const diagnostic = String(result.stderr || result.error?.message || '').trim().slice(0, 300);
      fail('strip-operation-failed', diagnostic || stripTool.id);
    }

    const outputBytes = fs.readFileSync(replayPath);
    if (outputPath != null) {
      const parent = path.dirname(targetPath);
      if (!fs.existsSync(parent)) fail('stripped-output-parent-missing');
      const atomicPath = path.join(parent, `.twin-manifest-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
      try {
        fs.copyFileSync(replayPath, atomicPath);
        fs.renameSync(atomicPath, targetPath);
      } finally {
        if (fs.existsSync(atomicPath)) fs.unlinkSync(atomicPath);
      }
    }
    return outputBytes;
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function metadataInput(options, stripTool) {
  const metadata = options.metadata && typeof options.metadata === 'object'
    ? { ...options, ...options.metadata }
    : options;
  const architecture = metadata.architecture && typeof metadata.architecture === 'object'
    ? metadata.architecture
    : { id: metadata.architecture, profile: metadata.profile };
  const compiler = metadata.compiler ?? metadata.toolchain;
  const linker = metadata.linker;
  return {
    schemaVersion: TWIN_MANIFEST_SCHEMA_VERSION,
    corpusId: metadata.corpusId,
    corpusVersion: metadata.corpusVersion,
    sourceIdentity: metadata.sourceIdentity,
    compiler,
    targetTriple: metadata.targetTriple,
    architecture,
    profile: metadata.profile ?? architecture?.profile,
    compileArgs: metadata.compileArgs ?? metadata.normalizedCompileArgs,
    compileOptions: metadata.compileOptions ?? metadata.normalizedCompileOptions ?? {},
    linker,
    buildIdentity: metadata.buildIdentity,
    debugArtifactSha256: metadata.debugArtifactSha256,
    stripTool,
    stripArgv: metadata.stripArgv ?? [...RECOGNIZED_STRIP_ARGV],
    stripConfig: metadata.stripConfig ?? { ...RECOGNIZED_STRIP_CONFIG },
    strippedArtifactSha256: metadata.strippedArtifactSha256,
    lineage: metadata.lineage,
  };
}

/**
 * Generate a same-binary twin and its manifest.
 *
 * Required options are debugArtifactPath, strippedArtifactPath, corpusId,
 * corpusVersion, sourceIdentity, compiler/toolchain, targetTriple,
 * architecture/profile, compileArgs/options, linker, and buildIdentity.
 */
export function generateTwinManifest(options = {}) {
  const debugArtifactPath = options.debugArtifactPath ?? options.debugPath ?? options.inputPath;
  const strippedArtifactPath = options.strippedArtifactPath ?? options.strippedPath ?? options.outputPath;
  if (strippedArtifactPath == null) fail('stripped-artifact-output-required');
  // Reject a caller-supplied operation/config before materializing any output;
  // the only operation that can ever run is the canonical strip-debug one.
  normalizeStripArgv(options.stripArgv ?? [...RECOGNIZED_STRIP_ARGV]);
  normalizeStripConfig(options.stripConfig ?? { ...RECOGNIZED_STRIP_CONFIG });
  const debugHash = sha256File(debugArtifactPath);
  const stripTool = resolveStripTool(options.stripTool ?? options.stripToolId ?? 'strip');
  const strippedBytes = applyRecognizedStrip({ debugArtifactPath, outputPath: strippedArtifactPath, stripTool });
  const strippedHash = sha256Bytes(strippedBytes);
  if (debugHash === strippedHash) fail('stripped-artifact-identical-to-debug');
  const body = metadataInput({
    ...options,
    debugArtifactSha256: debugHash,
    strippedArtifactSha256: strippedHash,
    lineage: {
      relation: TWIN_LINEAGE_RELATION,
      immutable: true,
      sourceArtifactSha256: debugHash,
      strippedArtifactSha256: strippedHash,
    },
  }, stripTool);
  return createTwinManifest(body);
}

function expectedValue(value, key) {
  if (value == null) return null;
  switch (key) {
    case 'sourceIdentity': return normalizeSourceIdentity(value);
    case 'compiler': return normalizeCompiler(value);
    case 'architecture': return normalizeArchitecture(value);
    case 'compileArgs': return normalizeCompileArgs(value);
    case 'compileOptions': return normalizeCompileOptions(value);
    case 'linker': return normalizeLinker(value);
    case 'stripTool': return normalizeTool(value, 'strip-tool');
    case 'stripArgv': return normalizeStripArgv(value);
    case 'stripConfig': return normalizeStripConfig(value);
    case 'corpusVersion': return normalizeCorpusVersion(value);
    case 'corpusId': return normalizeCorpusId(value);
    case 'targetTriple': return safeIdentityText(value, 'target-triple');
    case 'profile': return safeIdentityText(value, 'profile');
    case 'buildIdentity': return safeIdentityText(value, 'build-identity');
    case 'debugArtifactSha256': return sha256(value, 'debug-artifact-sha256');
    case 'strippedArtifactSha256': return sha256(value, 'stripped-artifact-sha256');
    default: return value;
  }
}

function expectedContext(options) {
  const context = options.expected ?? options.context ?? {};
  const values = { ...context };
  for (const key of [
    'corpusId', 'corpusVersion', 'sourceIdentity', 'compiler', 'targetTriple',
    'architecture', 'profile', 'compileArgs', 'compileOptions', 'linker',
    'buildIdentity', 'debugArtifactSha256', 'stripTool', 'stripArgv',
    'stripConfig', 'strippedArtifactSha256',
  ]) if (values[key] == null && options[key] != null) values[key] = options[key];
  if (values.toolchain != null && values.compiler == null) values.compiler = values.toolchain;
  return values;
}

function assertExpectedContext(manifest, options) {
  const context = expectedContext(options);
  for (const key of Object.keys(context)) {
    if (!BODY_KEYS.includes(key)) continue;
    const expected = expectedValue(context[key], key);
    if (expected == null) continue;
    const actual = manifest[key];
    if (stableStringify(actual) !== stableStringify(expected)) fail('expected-identity-mismatch', key);
  }
}

const ARTIFACT_EXPECTED_CONTEXT_KEYS = Object.freeze([
  'corpusId', 'corpusVersion', 'sourceIdentity', 'compiler', 'targetTriple',
  'architecture', 'profile', 'compileArgs', 'compileOptions', 'linker',
  'buildIdentity', 'stripTool', 'stripArgv', 'stripConfig',
]);

function assertCompleteArtifactContext(options) {
  const context = expectedContext(options);
  for (const key of ARTIFACT_EXPECTED_CONTEXT_KEYS) {
    if (context[key] == null) fail('artifact-expected-context-required', key);
  }
}

/**
 * Validate shape/digest and, when artifact paths are supplied, validate the
 * actual bytes and replay the allowlisted strip operation.  The latter is the
 * required production proof; shape-only validation is useful for scorecard
 * references and profile checks but cannot establish a twin by itself.
 */
export function validateTwinManifest(manifest, options = {}) {
  if (manifest == null || typeof manifest !== 'object' || Array.isArray(manifest)) fail('manifest-object-required');
  const normalizedBody = normalizeManifestBody(manifest);
  const expectedDigest = manifestDigestForBody(normalizedBody);
  if (manifest.manifestDigest !== expectedDigest) fail('manifest-digest-mismatch');
  assertExpectedContext({ ...normalizedBody, manifestDigest: expectedDigest }, options);

  const debugArtifactPath = options.debugArtifactPath ?? options.debugPath ?? options.debugPathname;
  const strippedArtifactPath = options.strippedArtifactPath ?? options.strippedPath ?? options.strippedPathname;
  if ((debugArtifactPath == null) !== (strippedArtifactPath == null)) fail('artifact-pair-incomplete');

  if (debugArtifactPath != null) {
    assertCompleteArtifactContext(options);
    const debugHash = sha256File(debugArtifactPath);
    const strippedHash = sha256File(strippedArtifactPath);
    if (debugHash !== normalizedBody.debugArtifactSha256) fail('debug-artifact-digest-mismatch');
    if (strippedHash !== normalizedBody.strippedArtifactSha256) fail('stripped-artifact-digest-mismatch');
    if (debugHash === strippedHash) fail('stripped-artifact-identical-to-debug');
    const observedToolVersion = commandVersion(normalizedBody.stripTool.id);
    if (observedToolVersion !== normalizedBody.stripTool.version) fail('strip-tool-version-drift');
    const workspace = temporaryDirectory();
    const replayInput = path.join(workspace, 'debug-artifact');
    const replayOutput = path.join(workspace, 'stripped-artifact');
    try {
      fs.copyFileSync(path.resolve(debugArtifactPath), replayInput);
      const result = spawnSync(normalizedBody.stripTool.id, [...normalizedBody.stripArgv, '--', replayInput], {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        shell: false,
      });
      if (result.error || result.status !== 0) fail('strip-replay-failed', String(result.stderr || result.error?.message || '').trim().slice(0, 300));
      // Keep a separate name in the workspace so the replay path is explicit
      // in the proof even though the recognized operation is in-place.
      fs.copyFileSync(replayInput, replayOutput);
      const replayHash = sha256File(replayOutput);
      if (replayHash !== strippedHash || replayHash !== normalizedBody.strippedArtifactSha256) fail('strip-replay-digest-mismatch');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }

  return Object.freeze({
    verified: true,
    manifestDigest: expectedDigest,
    debugArtifactSha256: normalizedBody.debugArtifactSha256,
    strippedArtifactSha256: normalizedBody.strippedArtifactSha256,
    replayedStrip: debugArtifactPath != null,
  });
}

export function validateTwinPair(options = {}) {
  const manifest = options.manifest ?? options.twinManifest;
  if (manifest == null) fail('manifest-required');
  return validateTwinManifest(manifest, options);
}

export function validateTwinManifestReference(reference) {
  if (reference == null || typeof reference !== 'object' || Array.isArray(reference)) fail('manifest-reference-object-required');
  const keys = Object.keys(reference);
  const allowed = new Set(['corpusId', 'corpusVersion', 'manifestDigest']);
  for (const key of keys) if (!allowed.has(key)) fail('manifest-reference-unknown-field', key);
  for (const key of allowed) if (!Object.prototype.hasOwnProperty.call(reference, key)) fail('manifest-reference-missing-field', key);
  return Object.freeze({
    corpusId: normalizeCorpusId(reference.corpusId),
    corpusVersion: normalizeCorpusVersion(reference.corpusVersion),
    manifestDigest: (() => {
      const value = text(reference.manifestDigest, 'manifest-reference-digest').toLowerCase();
      if (!DIGEST_RE.test(value)) fail('manifest-reference-digest-invalid');
      return value;
    })(),
  });
}

export function writeTwinManifest(manifest, outputPath) {
  const verified = validateTwinManifest(manifest);
  const normalized = { ...normalizeManifestBody(manifest), manifestDigest: verified.manifestDigest };
  if (typeof outputPath !== 'string' || !outputPath.trim()) fail('manifest-output-path-required');
  const resolved = path.resolve(outputPath);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent)) fail('manifest-output-parent-missing');
  const temporary = path.join(parent, `.twin-manifest-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, resolved);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return normalized;
}

export function loadTwinManifest(manifestPath) {
  const resolved = requireFilePath(manifestPath, 'manifest');
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')); } catch { fail('manifest-json-invalid'); }
  validateTwinManifest(parsed);
  return parsed;
}

// Names used by callers during the migration are kept as aliases to this one
// implementation; none of them introduce a second registry or verifier.
export const generateCompetitiveTwinManifest = generateTwinManifest;
export const verifyTwinManifest = validateTwinManifest;
export const verifyTwinPair = validateTwinPair;
export const buildTwinManifest = createTwinManifest;

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const [command, ...rest] = process.argv.slice(2);
    const value = (name) => {
      const index = rest.indexOf(name);
      return index < 0 ? null : rest[index + 1];
    };
    if (command === 'generate') {
      const debugArtifactPath = value('--debug');
      const strippedArtifactPath = value('--stripped');
      const manifestPath = value('--manifest');
      const metadataPath = value('--metadata');
      if (!metadataPath) fail('cli-metadata-required');
      const metadata = JSON.parse(fs.readFileSync(requireFilePath(metadataPath, 'metadata'), 'utf8'));
      const manifest = generateTwinManifest({ ...metadata, debugArtifactPath, strippedArtifactPath });
      if (manifestPath) writeTwinManifest(manifest, manifestPath);
      process.stdout.write(`${JSON.stringify(manifest)}\n`);
    } else if (command === 'validate') {
      const manifestPath = value('--manifest');
      const manifest = loadTwinManifest(manifestPath);
      const result = validateTwinManifest(manifest, {
        debugArtifactPath: value('--debug'),
        strippedArtifactPath: value('--stripped'),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      fail('cli-command-required');
    }
  } catch (error) {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}
