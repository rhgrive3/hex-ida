/**
 * Runs the frozen Phase 8 corpus through the real product decompiler paths.
 *
 * ARM64 keeps the historical public `decompile()` facade over frozen assembly
 * by default. An explicitly supplied, identity-validated native twin can use
 * the structured product path without changing the frozen corpus.
 * x86-64/RISC-V64 freeze real machine bytes, decode them with Hex's shipped
 * Capstone artifact, then use the existing target lifter + shared Semantic
 * IR/CFG/SSA/MemorySSA pipeline and the public semantic decompiler facade.
 * No architecture is represented by another architecture's parser or labels.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decompile } from '../../../js/decompile.js';
import { parseOperands } from '../../../js/arm64.js';
import { semanticAbiAdapter } from '../../../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../../../js/targets/abi/index.js';
import { arm64EncodingWord } from '../../../js/targets/architecture/arm64/encoding-word.js';
import { ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION } from '../../../js/targets/architecture/arm64/effects/index.js';
import { createX86DecodedInstruction, X86_DECODER_SEMANTIC_VERSION } from '../../../js/targets/architecture/x86_64/decoded-instruction.js';
import { createRiscv64DecodedInstruction, RISCV64_DECODER_SEMANTIC_VERSION } from '../../../js/targets/architecture/riscv64/decoded-instruction.js';
import { stableDigest } from '../../../js/core/identity/index.js';
import { createCapstoneX86Session } from '../../../tests/phase5/helpers/capstone-session.mjs';
import { createCapstoneRiscv64Session } from '../../../tests/phase6/helpers/capstone-session.mjs';
import { createCapstoneArm64Session } from '../../../tests/machine-effects/helpers/arm64-capstone-session.mjs';
import { validateCompetitiveTwinCapture } from '../competitive/workload-twins.mjs';

import { extractElfFunctionRecord, loadCorpus } from './build-corpus.mjs';
import { decompileDecodedProductFunction } from './decoded-function-adapter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ABI_ADAPTER = semanticAbiAdapter(AAPCS64_ABI);
const X86_SESSION = await createCapstoneX86Session();
const RISCV_SESSION = await createCapstoneRiscv64Session();
const ARM64_SESSION = await createCapstoneArm64Session();
let sessionsClosed = false;
function closeSessions() {
  if (sessionsClosed) return;
  sessionsClosed = true;
  try { X86_SESSION.close(); } catch { /* best effort */ }
  try { RISCV_SESSION.close(); } catch { /* best effort */ }
  try { ARM64_SESSION.close(); } catch { /* best effort */ }
}
process.once('exit', closeSessions);

const ARM64_NATIVE_CAPTURE_SCHEMA = 'hex-competitive-twin-capture/v1';
const ARM64_NATIVE_CAPTURE_WORKLOAD = 'phase8-decompiler-quality-corpus';
const ARM64_NATIVE_TARGET_TRIPLE = 'aarch64-unknown-linux-gnu';
const ARM64_NATIVE_COMPILER_ARGS = Object.freeze([
  `--target=${ARM64_NATIVE_TARGET_TRIPLE}`,
  '-g',
  '-c',
  '-fno-asynchronous-unwind-tables',
  '-fuse-ld=lld',
  '-nostdlib',
  '-no-pie',
  '-Wl,--build-id=none',
  '-Wl,-e,0',
]);
const ARM64_NATIVE_DECODER_SEMANTIC_VERSION = `arm64-capstone-a64-native/v1:${ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION}`;
const QUALITY_METRIC_IDS = new Set(['decompiler-quality-gotos', 'decompiler-quality-assembly-fallbacks']);

function codeText(line) { return String(line || '').replace(/\/\/.*$/, '').trim(); }

/*
 * `sourceMap.length` is a rendering counter, not a provenance counter. A
 * precise upstream lifter can collapse several unknown/assembly rows into one
 * printed node while preserving (or improving) the instruction and IR
 * provenance. Phase 8 therefore freezes the identity-bearing sets separately.
 *
 * BigInts reach the printer as strings with the `n` suffix in a few historical
 * paths. Remove that presentation detail before sorting/digesting so a source
 * address has one stable identity across the old baseline and current runs.
 */
function provenanceScalar(value) {
  const text = String(value);
  return /^-?\d+n$/.test(text) ? text.slice(0, -1) : text;
}

function compareProvenanceScalars(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  if (/^-?\d+$/.test(leftText) && /^-?\d+$/.test(rightText)) {
    const leftNumber = BigInt(leftText);
    const rightNumber = BigInt(rightText);
    if (leftNumber < rightNumber) return -1;
    if (leftNumber > rightNumber) return 1;
  }
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function sortedProvenanceSet(values) {
  if (!Array.isArray(values)) return null;
  return [...new Set(values.map(provenanceScalar))].sort(compareProvenanceScalars);
}

/**
 * Extracts the identity-bearing provenance from one printed source map.
 *
 * `null` is deliberately distinct from an empty set: a missing source map is
 * not evidence that the function has no provenance. The verifier treats it as
 * a fail-closed measurement failure when the frozen baseline requires it.
 */
export function provenanceFromSourceMap(sourceMap) {
  if (!Array.isArray(sourceMap)) return null;
  const sourceAddresses = sortedProvenanceSet(sourceMap.flatMap((entry) => entry?.source?.addresses ?? []));
  const irProvenance = sortedProvenanceSet(sourceMap.flatMap((entry) => entry?.source?.ir ?? []));
  return {
    sourceAddresses,
    sourceAddressesDigest:stableDigest(sourceAddresses),
    irProvenance,
    irProvenanceDigest:stableDigest(irProvenance),
    irProvenanceCount:irProvenance.length,
  };
}

function memoryInfo(mnemonic, operands) {
  const name = String(mnemonic).toLowerCase();
  if (!/^(?:ld|st)/.test(name)) return null;
  const memory = operands.find((operand) => operand?.k === 'mem');
  if (!memory) return null;
  const first = operands.find((operand) => operand?.k === 'reg');
  let size = Math.max(1, Number(first?.bits || 64) / 8);
  if (/b$/.test(name) || /rb$/.test(name)) size = 1;
  else if (/h$/.test(name) || /rh$/.test(name)) size = 2;
  else if (/sw$/.test(name)) size = 4;
  if (/^(?:ldp|stp|ldnp|stnp)/.test(name)) size *= 2;
  return { kind:/^ld/.test(name) ? 'load' : 'store', size, stack:memory.base?.cls === 'sp' || memory.base?.num === 29 };
}

export function modelFromAssembly(assembly, name, baseAddress = 0x100000n) {
  const raw = [];
  const labels = new Map();
  let row = 0;
  for (const line of String(assembly).split(/\r?\n/)) {
    const text = codeText(line);
    if (!text) continue;
    const label = /^(\.L[\w.$]+):/.exec(text);
    if (label) { labels.set(label[1], row); continue; }
    if (text.startsWith('.') || text.startsWith('//') || text.startsWith('#')) continue;
    const match = /^([A-Za-z][\w.]*)\s*(.*)$/.exec(text);
    if (!match) continue;
    raw.push({ row:row++, mnemonic:match[1].toLowerCase(), operands:match[2].trim() });
  }
  if (raw.length === 0) return null;

  const addressOfRow = (value) => baseAddress + BigInt(value) * 4n;
  const instructions = raw.map((item) => {
    const ops = parseOperands(item.operands);
    const mnemonic = item.mnemonic;
    const targetText = item.operands.split(',').at(-1)?.trim();
    const targetRow = labels.get(targetText);
    const conditional = /^b\.[a-z]{2}$/.test(mnemonic) || /^(?:cbz|cbnz|tbz|tbnz)$/.test(mnemonic);
    const branch = mnemonic === 'b' || mnemonic === 'br' || conditional;
    return {
      ...item,
      ops,
      address:addressOfRow(item.row),
      isReturn:mnemonic === 'ret',
      isBranch:branch,
      isConditional:conditional,
      isCall:mnemonic === 'bl' || mnemonic === 'blr',
      branchTarget:targetRow == null ? null : addressOfRow(targetRow),
      callTarget:null,
      memory:memoryInfo(mnemonic, ops),
      reads:[], writes:[], data:false,
    };
  });

  const starts = new Set([0]);
  for (const instruction of instructions) {
    if (instruction.branchTarget != null) starts.add(Number((instruction.branchTarget - baseAddress) / 4n));
    if ((instruction.isBranch || instruction.isReturn) && instruction.row + 1 < instructions.length) starts.add(instruction.row + 1);
  }
  const sorted = [...starts].filter((value) => value >= 0 && value < instructions.length).sort((left, right) => left - right);
  const basicBlocks = sorted.map((start, index) => {
    const end = (sorted[index + 1] ?? instructions.length) - 1;
    return { startRow:start, endRow:end, rows:Array.from({ length:end - start + 1 }, (_unused, offset) => start + offset) };
  });
  return { name, instructions, basicBlocks, semantic:[], calls:[] };
}

function bytesOf(entry) {
  if (entry.representation !== 'machine-bytes' || typeof entry.bytes !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(entry.bytes)) {
    throw new TypeError(`phase8 corpus: invalid machine bytes for ${entry.id}`);
  }
  return Uint8Array.from(Buffer.from(entry.bytes, 'hex'));
}

function decodedCoverage(instructions, expectedBytes) {
  return (instructions || []).reduce((total, instruction) => total + Number(instruction.length ?? instruction.size ?? 0), 0) === expectedBytes;
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(Buffer.from(value)).digest('hex');
}

function compilerVersionToken(value) {
  return String(value || '').match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
}

/** Return the capture-only artifact id for one frozen ARM64 corpus entry. */
export function nativeArm64ArtifactIdFor(entry) {
  if (entry?.architectureId !== 'arm64' || typeof entry.source !== 'string' || typeof entry.optimization !== 'string') return null;
  return `arm64-native-${entry.source}-${entry.optimization.replace(/^-/, '')}`;
}

function nativeArm64FunctionKey(entry) {
  return `${entry.source}\u0000${entry.optimization}`;
}

function nativeCaptureFailure(reason, detail = '') {
  throw new TypeError(`phase8-native-arm64-capture-${reason}${detail ? `:${detail}` : ''}`);
}

function fileBytes(filePath, code) {
  if (typeof filePath !== 'string' || !filePath.trim()) nativeCaptureFailure(`${code}-path-missing`);
  const resolved = path.resolve(filePath);
  let stat;
  try { stat = fs.statSync(resolved); } catch { nativeCaptureFailure(`${code}-missing`, resolved); }
  if (!stat.isFile()) nativeCaptureFailure(`${code}-not-file`, resolved);
  try { return Buffer.from(fs.readFileSync(resolved)); } catch (error) {
    nativeCaptureFailure(`${code}-unreadable`, error?.message || String(error));
  }
}

function sourceIdentityFor(sourceDirectory, sourceName) {
  if (typeof sourceDirectory !== 'string' || !sourceDirectory.trim()) nativeCaptureFailure('source-directory-missing');
  if (typeof sourceName !== 'string' || !sourceName.trim()) nativeCaptureFailure('source-name-missing');
  const root = path.resolve(sourceDirectory);
  const sourcePath = path.resolve(root, sourceName);
  if (sourcePath !== root && !sourcePath.startsWith(`${root}${path.sep}`)) nativeCaptureFailure('source-path-invalid', sourceName);
  const bytes = fileBytes(sourcePath, 'source');
  return {
    path:sourcePath,
    ids:new Set([sourceName, path.relative(ROOT, sourcePath).replaceAll('\\', '/')]),
    sha256:sha256Bytes(bytes),
    text:bytes.toString('utf8'),
  };
}

function expectedNativeEntries(corpus) {
  if (!Array.isArray(corpus?.functions) || corpus.functions.length === 0) nativeCaptureFailure('corpus-functions-missing');
  const entries = corpus.functions.filter((entry) => entry?.architectureId === 'arm64');
  if (entries.length === 0) nativeCaptureFailure('corpus-arm64-functions-missing');
  const ids = new Set();
  for (const entry of entries) {
    if (typeof entry.id !== 'string' || !entry.id.trim()
        || typeof entry.source !== 'string' || !entry.source.trim()
        || typeof entry.function !== 'string' || !entry.function.trim()
        || typeof entry.optimization !== 'string' || !/^-[A-Za-z]\d+$/.test(entry.optimization)
        || entry.representation !== 'assembly'
        || ids.has(entry.id)) {
      nativeCaptureFailure('corpus-entry-invalid', String(entry?.id || 'unknown'));
    }
    ids.add(entry.id);
  }
  return entries;
}

function productionRowFor(capture, artifact) {
  const rows = capture.measurement?.productionObservation?.rows;
  if (!Array.isArray(rows)) nativeCaptureFailure('production-observation-missing');
  const row = rows.find((candidate) => candidate?.id === artifact.id);
  if (!row) nativeCaptureFailure('production-row-missing', artifact.id);
  return row;
}

function validateNativeArtifact(corpus, capture, artifact, sourceRecords, compilerToken) {
  const manifest = artifact?.manifest;
  if (artifact == null || typeof artifact !== 'object' || manifest == null || typeof manifest !== 'object') {
    nativeCaptureFailure('artifact-manifest-missing', String(artifact?.id || 'unknown'));
  }
  if (manifest.corpusId !== corpus.corpusId || manifest.corpusVersion !== corpus.corpusVersion) {
    nativeCaptureFailure('artifact-corpus-identity-mismatch', artifact.id);
  }
  if (manifest.architecture?.id !== 'arm64'
      || manifest.architecture?.profile !== 'aarch64-linux-gnu'
      || manifest.targetTriple !== ARM64_NATIVE_TARGET_TRIPLE) {
    nativeCaptureFailure('artifact-target-mismatch', artifact.id);
  }
  const options = manifest.compileOptions;
  if (options?.captureOnly !== true
      || options?.representation !== 'machine-bytes'
      || options?.debug !== true
      || options?.generator !== 'phase8-decompiler-quality-corpus/v2') {
    nativeCaptureFailure('artifact-capture-contract-mismatch', artifact.id);
  }
  if (manifest.compiler?.id !== 'clang'
      || compilerToken == null
      || compilerVersionToken(manifest.compiler?.version) !== compilerToken) {
    nativeCaptureFailure('artifact-compiler-mismatch', artifact.id);
  }
  const source = sourceRecords.get(manifest.sourceIdentity?.id);
  if (!source || manifest.sourceIdentity?.sha256 !== source.sha256) {
    nativeCaptureFailure('artifact-source-mismatch', artifact.id);
  }
  const debugBytes = fileBytes(artifact.debugArtifactPath, 'debug-artifact');
  const strippedBytes = fileBytes(artifact.strippedArtifactPath, 'stripped-artifact');
  if (manifest.debugArtifactSha256 !== sha256Bytes(debugBytes)) nativeCaptureFailure('debug-artifact-hash-mismatch', artifact.id);
  if (manifest.strippedArtifactSha256 !== sha256Bytes(strippedBytes)) nativeCaptureFailure('stripped-artifact-hash-mismatch', artifact.id);
  const row = productionRowFor(capture, artifact);
  if (row.debugBytes !== debugBytes.byteLength
      || row.strippedBytes !== strippedBytes.byteLength
      || row.debugArtifactSha256 !== manifest.debugArtifactSha256
      || row.strippedArtifactSha256 !== manifest.strippedArtifactSha256) {
    nativeCaptureFailure('production-row-mismatch', artifact.id);
  }
  return Object.freeze({ artifact, manifest, debugBytes, functions:new Map() });
}

/**
 * Validate the capture-only ARM64 twins and index them by source/optimization.
 * The frozen ARM64 entries remain assembly; this index is only used by the
 * explicit native observation path and never changes the corpus denominator.
 */
function validatedNativeArm64Artifacts(corpus, capture, { sourceDirectory = path.join(ROOT, 'tests/phase8/corpus/sources') } = {}) {
  if (capture == null) return null;
  try {
    // The native adapter consumes the actual ELF bytes, so archived metadata
    // alone cannot establish provenance. Replay the allowlisted strip for each
    // admitted twin in addition to the independent byte/hash checks below.
    validateCompetitiveTwinCapture(capture, { replayArtifacts:true });
  } catch (error) {
    nativeCaptureFailure('identity-invalid', error?.message || String(error));
  }
  if (capture.schemaVersion !== ARM64_NATIVE_CAPTURE_SCHEMA) nativeCaptureFailure('schema-mismatch');
  if (!QUALITY_METRIC_IDS.has(capture.metricId)) nativeCaptureFailure('metric-mismatch', String(capture.metricId));
  if (capture.workloadId !== ARM64_NATIVE_CAPTURE_WORKLOAD) nativeCaptureFailure('workload-mismatch', String(capture.workloadId));
  if (capture.corpusId !== corpus.corpusId || capture.corpusVersion !== corpus.corpusVersion) nativeCaptureFailure('corpus-identity-mismatch');

  const entries = expectedNativeEntries(corpus);
  const sourceNames = [...new Set(corpus.functions.map((entry) => entry?.source).filter((name) => typeof name === 'string' && name))]
    .sort((left, right) => left.localeCompare(right));
  const sourceRecords = new Map();
  for (const sourceName of sourceNames) {
    const record = sourceIdentityFor(sourceDirectory, sourceName);
    for (const id of record.ids) sourceRecords.set(id, record);
  }
  if (typeof corpus.sourceDigest !== 'string'
      || stableDigest(sourceNames.map((name) => ({ name, text:sourceRecords.get(name)?.text }))) !== corpus.sourceDigest) {
    nativeCaptureFailure('corpus-source-digest-mismatch');
  }
  const compilerToken = compilerVersionToken(corpus.toolchain?.compiler);
  if (compilerToken == null) nativeCaptureFailure('corpus-compiler-identity-missing');

  const artifacts = Array.isArray(capture.artifacts) ? capture.artifacts : [];
  const expectedIds = [...new Set(entries.map(nativeArm64ArtifactIdFor))].sort();
  const nativeArtifacts = artifacts.filter((artifact) => artifact?.manifest?.compileOptions?.captureOnly === true);
  const nativeIds = nativeArtifacts.map((artifact) => artifact?.id).sort();
  if (nativeIds.length !== expectedIds.length || stableDigest(nativeIds) !== stableDigest(expectedIds)) {
    nativeCaptureFailure('denominator-mismatch', `${nativeIds.join(',')}!=${expectedIds.join(',')}`);
  }

  const byId = new Map(nativeArtifacts.map((artifact) => [artifact.id, artifact]));
  const expectedByArtifactId = new Map();
  const entriesById = new Map();
  for (const entry of entries) {
    const artifactId = nativeArm64ArtifactIdFor(entry);
    const expected = expectedByArtifactId.get(artifactId);
    if (expected != null && (expected.source !== entry.source || expected.optimization !== entry.optimization)) {
      nativeCaptureFailure('artifact-ambiguous', artifactId);
    }
    expectedByArtifactId.set(artifactId, expected ?? {
      source:entry.source,
      optimization:entry.optimization,
      profile:`arm64-${entry.optimization}`,
      compileArgs:[ARM64_NATIVE_COMPILER_ARGS[0], '-g', entry.optimization, ...ARM64_NATIVE_COMPILER_ARGS.slice(2)],
    });
    entriesById.set(entry.id, Object.freeze({
      id:entry.id,
      source:entry.source,
      function:entry.function,
      optimization:entry.optimization,
      architectureId:entry.architectureId,
      targetTriple:entry.targetTriple,
      representation:entry.representation,
    }));
  }

  const recordsByArtifactId = new Map();
  for (const [artifactId, expected] of expectedByArtifactId) {
    const artifact = byId.get(artifactId);
    if (!artifact) nativeCaptureFailure('artifact-unmapped', artifactId);
    const validated = validateNativeArtifact(corpus, capture, artifact, sourceRecords, compilerToken);
    if (validated.manifest.profile !== expected.profile
        || validated.manifest.compileOptions?.optimization !== expected.optimization
        || stableDigest(validated.manifest.compileArgs) !== stableDigest(expected.compileArgs)) {
      nativeCaptureFailure('artifact-optimization-mismatch', artifactId);
    }
    recordsByArtifactId.set(artifactId, validated);
  }

  const byKey = new Map();
  const byEntryId = new Map();
  for (const entry of entries) {
    const artifactId = nativeArm64ArtifactIdFor(entry);
    const record = recordsByArtifactId.get(artifactId);
    if (!record) nativeCaptureFailure('artifact-unmapped', entry.id);
    const key = nativeArm64FunctionKey(entry);
    if (byKey.has(key)) {
      const existing = byKey.get(key);
      if (existing.artifact.id !== record.artifact.id) nativeCaptureFailure('artifact-ambiguous', key);
    } else {
      byKey.set(key, record);
    }
    byEntryId.set(entry.id, Object.freeze({ entry:entriesById.get(entry.id), record }));
  }
  const contentDigest = stableDigest([...recordsByArtifactId.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, record]) => ({
      id,
      debugArtifactSha256:record.manifest.debugArtifactSha256,
      strippedArtifactSha256:record.manifest.strippedArtifactSha256,
    })));
  return Object.freeze({
    captureDigest:capture.captureDigest,
    artifactIdsDigest:capture.denominator.artifactIdsDigest,
    contentDigest,
    byKey,
    byEntryId,
    entriesById,
  });
}

function signExtend(value, bits) {
  const width = 1 << bits;
  const sign = 1 << (bits - 1);
  const normalized = value & (width - 1);
  return BigInt(normalized & sign ? normalized - width : normalized);
}

function displayedBranchTarget(opStr) {
  const token = String(opStr || '').split(',').at(-1)?.trim().replace(/^#/, '');
  if (/^-?0x[0-9a-f]+$/i.test(token) || /^-?\d+$/.test(token)) {
    try { return BigInt(token); } catch { return null; }
  }
  return null;
}

function encodedBranchTarget(mnemonic, word, address) {
  const op = String(mnemonic || '').toLowerCase();
  const value = Number(word) >>> 0;
  if (op === 'b' || op === 'bl') return BigInt(address) + (signExtend(value & 0x03ffffff, 26) << 2n);
  if (/^b\.[a-z]{2}$/.test(op)) return BigInt(address) + (signExtend((value >>> 5) & 0x7ffff, 19) << 2n);
  if (op === 'cbz' || op === 'cbnz') return BigInt(address) + (signExtend((value >>> 5) & 0x7ffff, 19) << 2n);
  if (op === 'tbz' || op === 'tbnz') return BigInt(address) + (signExtend((value >>> 5) & 0x3fff, 14) << 2n);
  return null;
}

function branchTargetFor(mnemonic, opStr, word, address) {
  const isDirect = mnemonic === 'b' || mnemonic === 'bl' || /^b\.[a-z]{2}$/.test(mnemonic)
    || mnemonic === 'cbz' || mnemonic === 'cbnz' || mnemonic === 'tbz' || mnemonic === 'tbnz';
  if (!isDirect) return null;
  const encoded = encodedBranchTarget(mnemonic, word, address);
  const displayed = displayedBranchTarget(opStr);
  if (encoded == null || displayed == null || encoded !== displayed) {
    nativeCaptureFailure('branch-target-mismatch', `${mnemonic}@${String(address)}`);
  }
  return encoded;
}

/** Decode one byte-backed A64 function into the canonical product input shape. */
export function decodeNativeArm64Function(bytes, { baseAddress = 0x100000n, instructionIdPrefix = 'phase8:native' } = {}) {
  const input = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
  if (input.length === 0 || input.length % 4 !== 0) nativeCaptureFailure('function-bytes-invalid');
  const raw = ARM64_SESSION.decode(input, baseAddress);
  if (!decodedCoverage(raw, input.length)) nativeCaptureFailure('decoder-coverage-mismatch');
  let offset = 0;
  const instructions = raw.map((instruction, index) => {
    const size = Number(instruction.size ?? instruction.length);
    if (size !== 4 || offset + size > input.length) nativeCaptureFailure('instruction-width-invalid', String(index));
    const address = BigInt(instruction.address);
    const expectedAddress = BigInt(baseAddress) + BigInt(offset);
    if (address !== expectedAddress) nativeCaptureFailure('instruction-address-mismatch', String(index));
    const rawBytes = Uint8Array.from(input.slice(offset, offset + size));
    const word = arm64EncodingWord(rawBytes, 0);
    if (word == null) nativeCaptureFailure('instruction-encoding-missing', String(index));
    const mnemonic = String(instruction.mnemonic || '').toLowerCase();
    const opStr = String(instruction.opStr || '');
    const instructionId = `${instructionIdPrefix}:${index}`;
    const branchTarget = branchTargetFor(mnemonic, opStr, word, address);
    const callTarget = mnemonic === 'bl' ? branchTarget : null;
    offset += size;
    return Object.freeze({
      instructionId,
      address,
      length:size,
      size,
      mnemonic,
      operands:opStr,
      opStr,
      ops:parseOperands(opStr),
      mode:'a64',
      rawBytes,
      word,
      origin:{ instructionIds:[instructionId] },
      ...(branchTarget == null ? {} : { branchTarget }),
      ...(callTarget == null ? {} : { callTarget }),
    });
  });
  if (offset !== input.length) nativeCaptureFailure('decoder-offset-mismatch');
  return Object.freeze(instructions);
}

function nativeFunctionBytes(record, entry) {
  let functionRecord = record.functions?.get(entry.function);
  if (functionRecord != null) return functionRecord;
  try { functionRecord = extractElfFunctionRecord(record.debugBytes, entry.function); } catch (error) {
    nativeCaptureFailure('function-bytes-unreadable', `${entry.id}:${error?.message || String(error)}`);
  }
  if (functionRecord == null
      || !(functionRecord.bytes instanceof Uint8Array)
      || functionRecord.bytes.length === 0
      || functionRecord.bytes.length % 4 !== 0) {
    nativeCaptureFailure('function-unmapped', entry.id);
  }
  if (functionRecord.elfType !== 2 || functionRecord.address == null || functionRecord.relocationSectionCount !== 0) {
    nativeCaptureFailure('function-relocations-or-address-unavailable', entry.id);
  }
  const copy = {
    bytes:Uint8Array.from(functionRecord.bytes),
    address:BigInt(functionRecord.address),
  };
  record.functions.set(entry.function, copy);
  return copy;
}

/** Build the explicit, fail-closed native ARM64 observation adapter. */
export function createNativeArm64CaptureAdapter({ corpus = loadCorpus(), capture, sourceDirectory = path.join(ROOT, 'tests/phase8/corpus/sources') } = {}) {
  const validated = validatedNativeArm64Artifacts(corpus, capture, { sourceDirectory });
  if (validated == null) return null;
  return Object.freeze({
    captureDigest:validated.captureDigest,
    artifactIdsDigest:validated.artifactIdsDigest,
    contentDigest:validated.contentDigest,
    decompile(entry, {
      decompilerTimeBudgetMs = 20000,
      phase8WorkBudget = undefined,
      deterministicTransforms = true,
      phase8Optimize = true,
    } = {}) {
      if (entry?.architectureId !== 'arm64') return { id:entry?.id, failure:'phase8-native-arm64-entry-architecture-mismatch' };
      const admitted = validated.entriesById.get(entry?.id);
      if (admitted == null
          || admitted.source !== entry.source
          || admitted.function !== entry.function
          || admitted.optimization !== entry.optimization
          || admitted.targetTriple !== entry.targetTriple
          || admitted.representation !== entry.representation) {
        return { id:entry?.id, failure:'phase8-native-arm64-entry-identity-mismatch' };
      }
      const binding = validated.byEntryId.get(admitted.id);
      if (!binding) return { id:admitted.id, failure:'phase8-native-arm64-entry-unmapped' };
      try {
        const functionRecord = nativeFunctionBytes(binding.record, admitted);
        const instructions = decodeNativeArm64Function(functionRecord.bytes, {
          baseAddress:functionRecord.address,
          instructionIdPrefix:`phase8-native:${admitted.id}`,
        });
        const result = decompileDecodedProductFunction({
          architecture:'arm64',
          platform:'linux',
          name:admitted.function,
          instructions,
          decoderSemanticVersion:ARM64_NATIVE_DECODER_SEMANTIC_VERSION,
          mode:'a64',
          binaryId:`phase8-native-capture-content:${validated.contentDigest}`,
          sliceId:`${admitted.id}:${validated.artifactIdsDigest}`,
          dataEndianness:'little',
          instructionEndianness:'little',
        }, {
          decompilerTimeBudgetMs,
          deterministicTransforms,
          phase8Optimize,
          ...(phase8WorkBudget != null ? { phase8WorkBudget } : {}),
        });
        return { id:admitted.id, result };
      } catch (error) {
        return { id:admitted.id, failure:error?.message || String(error) };
      }
    },
  });
}

function decodedFor(entry, baseAddress) {
  const bytes = bytesOf(entry);
  if (entry.architectureId === 'x86_64') {
    const raw = X86_SESSION.decode(bytes, baseAddress);
    if (!decodedCoverage(raw, bytes.length)) throw new Error(`phase8 corpus: x86_64 decoder did not cover all bytes for ${entry.id}`);
    return {
      instructions:raw.map((instruction, index) => createX86DecodedInstruction({
        ...instruction,
        instructionId:`phase8:${entry.id}:${index}`,
      })),
      decoderSemanticVersion:X86_DECODER_SEMANTIC_VERSION,
      mode:'long-64',
    };
  }
  if (entry.architectureId === 'riscv64') {
    const raw = RISCV_SESSION.decode(bytes, baseAddress);
    if (!decodedCoverage(raw, bytes.length)) throw new Error(`phase8 corpus: riscv64 decoder did not cover all bytes for ${entry.id}`);
    return {
      instructions:raw.map((instruction, index) => createRiscv64DecodedInstruction({
        ...instruction,
        instructionId:`phase8:${entry.id}:${index}`,
      })),
      decoderSemanticVersion:RISCV64_DECODER_SEMANTIC_VERSION,
      mode:'rv64imc',
    };
  }
  throw new TypeError(`phase8 corpus: unsupported machine-byte architecture ${entry.architectureId}`);
}

export function decompileEntry(entry, {
  decompilerTimeBudgetMs = 20000,
  phase8WorkBudget = undefined,
  index = 0,
  deterministicTransforms = true,
  phase8Optimize = true,
} = {}) {
  const baseAddress = 0x100000n + BigInt(index) * 0x10000n;
  try {
    if (entry.architectureId === 'arm64') {
      if (entry.representation !== 'assembly') return { id:entry.id, failure:'arm64 corpus entry is not frozen assembly' };
      const model = modelFromAssembly(entry.assembly, entry.function, baseAddress);
      if (!model) return { id:entry.id, failure:'assembly could not be parsed into a function model' };
      const rowOfAddress = new Map(model.instructions.map((instruction) => [instruction.address.toString(), instruction.row]));
      const result = decompile(model, {
        name:entry.function,
        addr:model.instructions[0].address,
        rowOfAddress:(address) => rowOfAddress.get(address?.toString()) ?? null,
        abiAdapter:ABI_ADAPTER,
        decompilerTimeBudgetMs,
        deterministicTransforms,
        phase8Optimize,
        ...(phase8WorkBudget != null ? { phase8WorkBudget } : {}),
      });
      return { id:entry.id, result };
    }

    const decoded = decodedFor(entry, baseAddress);
    const result = decompileDecodedProductFunction({
      architecture:entry.architectureId,
      platform:'linux',
      name:entry.function,
      instructions:decoded.instructions,
      decoderSemanticVersion:decoded.decoderSemanticVersion,
      mode:decoded.mode,
      binaryId:`phase8-corpus:${entry.id}`,
      sliceId:`${entry.architectureId}:${entry.optimization}`,
      dataEndianness:'little',
      instructionEndianness:'little',
    }, {
      decompilerTimeBudgetMs,
      deterministicTransforms,
      phase8Optimize,
      ...(phase8WorkBudget != null ? { phase8WorkBudget } : {}),
    });
    return { id:entry.id, result };
  } catch (error) {
    return { id:entry.id, failure:error?.message || String(error) };
  }
}

export function observationOf(entry, outcome) {
  if (outcome.failure) return { id:entry.id, architectureId:entry.architectureId, failure:outcome.failure };
  const result = outcome.result;
  const metrics = result?.metrics ?? {};
  const provenance = provenanceFromSourceMap(result?.sourceMap);
  return {
    id:entry.id,
    architectureId:entry.architectureId,
    function:entry.function,
    optimization:entry.optimization,
    semantic:!!result?.semantic,
    pseudocode:result?.pseudocode ?? '',
    lineCount:Array.isArray(result?.lines) ? result.lines.length : 0,
    sourceMappedNodes:Array.isArray(result?.sourceMap) ? result.sourceMap.length : 0,
    provenance,
    provenanceDigest:stableDigest((result?.lines ?? []).map((line) => ({
      kind:line?.kind ?? null,
      addresses:(line?.source?.addresses ?? []).map((address) => String(address)),
      rows:(line?.source?.rows ?? []).map((row) => Number(row)),
    }))),
    budgetExceeded:metrics.rewriteBudgetExceeded ?? null,
    completeness:result?.ctx?.decompilerPipeline?.completeness ?? null,
    readability:{
      rawAssemblyFallbacks:metrics.rawAssemblyFallbacks ?? null,
      gotos:metrics.gotos ?? null,
      temporaries:metrics.temporaries ?? null,
      redundantCasts:metrics.redundantCasts ?? null,
      rewrittenExpressions:metrics.rewrittenExpressions ?? null,
      structured:metrics.structured ?? null,
    },
    prototypeArity:Array.isArray(result?.prototype?.parameters) ? result.prototype.parameters.length : null,
    highVariableGroups:Array.isArray(result?.highVariables?.groups) ? result.highVariables.groups.length : null,
    aggregateLayouts:Array.isArray(result?.aggregateLayouts) ? result.aggregateLayouts.length : null,
    phase8:result?.phase8 == null ? null : {
      status:result.phase8.status,
      enabledStages:[...(result.phase8.enabledStages ?? [])],
      published:result.phase8.published,
      completeness:result.phase8.completeness,
      transformCount:result.phase8.transformCount,
      produced:[...(result.phase8.produced ?? [])],
      invalidated:[...(result.phase8.invalidated ?? [])],
      registryDigest:result.phase8.registryDigest,
      publicationDigest:result.phase8.publicationDigest,
    },
    phase8Projection:result?.phase8Projection == null ? null : {
      version:result.phase8Projection.version,
      transformCount:result.phase8Projection.transformCount,
    },
  };
}

export function observeCorpus({
  corpus = loadCorpus(),
  nativeArm64Capture = null,
  nativeCapture = null,
  sourceDirectory = path.join(ROOT, 'tests/phase8/corpus/sources'),
  decompilerTimeBudgetMs = 20000,
  phase8WorkBudget = undefined,
  deterministicTransforms = true,
  phase8Optimize = true,
} = {}) {
  const suppliedNativeCapture = nativeArm64Capture ?? nativeCapture;
  let nativeAdapter = null;
  let nativeAdapterFailure = null;
  if (suppliedNativeCapture != null) {
    try {
      nativeAdapter = createNativeArm64CaptureAdapter({ corpus, capture:suppliedNativeCapture, sourceDirectory });
    } catch (error) {
      nativeAdapterFailure = error?.message || String(error);
    }
  }
  return corpus.functions.map((entry, index) => {
    if (entry.architectureId === 'arm64' && suppliedNativeCapture != null) {
      const outcome = nativeAdapterFailure == null
        ? nativeAdapter.decompile(entry, { decompilerTimeBudgetMs, phase8WorkBudget, index, deterministicTransforms, phase8Optimize })
        : { id:entry.id, failure:nativeAdapterFailure };
      return observationOf(entry, outcome);
    }
    return observationOf(entry, decompileEntry(entry, {
      decompilerTimeBudgetMs,
      phase8WorkBudget,
      index,
      deterministicTransforms,
      phase8Optimize,
    }));
  });
}

export { closeSessions };
