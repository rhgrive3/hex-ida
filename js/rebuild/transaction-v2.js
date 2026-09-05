import { deepFreeze, stableDigest } from '../core/identity/index.js';
import { isValidatedStage2CapabilityProof } from '../platform/stage2-profile-evidence.js';
import { discoveryArtifactForRebuild, isFactoryIssuedDiscoveryRebuildBinding, verifyDiscoveryReparse } from '../analysis/discovery/artifact.js';

export const REBUILD_TRANSACTION_SCHEMA = 'hex-rebuild-transaction-v2';
export const REBUILD_VALIDATION_SCHEMA = 'hex-rebuild-validation-v2';
export const INDEPENDENT_ORACLE_RESULT_SCHEMA = 'hex-rebuild-independent-oracle-result-v1';
const ATOMIC_PUBLICATION_PROTOCOLS = new Set(['temp-then-atomic-rename', 'transactional-store']);
const REBUILD_FORMATS = new Set(['macho', 'elf', 'pe']);
const FORMAT_PROFILES = Object.freeze({
  macho: Object.freeze(['macho:64']),
  elf: Object.freeze(['elf:64']),
  pe: Object.freeze(['pe:pe32', 'pe:pe32+']),
});
export const F6_REBUILD_UNITS = Object.freeze([
  'transaction-identity', 'layout-and-structure', 'relocations-and-bindings', 'branch-ranges',
  'unwind-and-debug', 'imports-and-exports', 'signature-consequence', 'loader-reparse',
  'independent-differential-oracle', 'atomic-publication', 'real-fixture', 'negative-validator-corpus',
]);
export const F6_REBUILD_PROFILES = Object.freeze(['macho:64', 'elf:64', 'pe:pe32', 'pe:pe32+']);
const F6_NATIVE_INVARIANT_UNITS = Object.freeze([
  'layout-and-structure', 'relocations-and-bindings', 'branch-ranges',
  'unwind-and-debug', 'imports-and-exports', 'signature-consequence',
]);
const F6_PRESERVATION_ORACLE_IDENTITY = 'external:llvm-readobj';
const F6_PRESERVATION_ORACLE_VERSION = 'Ubuntu LLVM version 18.1.3';
const TRUSTED_INDEPENDENT_ORACLE_PROVIDERS = new WeakSet();

// The preservation denominator accepts only the repository's registered
// independent-provider adapter. A caller-supplied function cannot mint a
// preservation result by copying the result schema or report fields.
export function registerCanonicalIndependentOracleProvider(provider) {
  if (typeof provider !== 'function') throw new TypeError('independent-oracle-provider-required');
  TRUSTED_INDEPENDENT_ORACLE_PROVIDERS.add(provider);
  return provider;
}

function isCanonicalIndependentOracleProvider(provider) {
  return typeof provider === 'function' && TRUSTED_INDEPENDENT_ORACLE_PROVIDERS.has(provider);
}
export const F6_UNIMPLEMENTED_OPERATION_UNITS = Object.freeze([]);
// These are evaluator-level bounded capabilities, not replacements for the
// locked profile-wide F6 units above.  A capability can close only when its
// exact production operation, loader reparse, and independent oracle evidence
// are present; the parent unit remains blocking until the complete matrix is
// implemented.
export const F6_BOUNDED_OPERATION_CELLS = Object.freeze([
  'elf:64:layout-and-structure:terminal-sht-nobits-append',
  'pe:pe32:layout-and-structure:text-virtual-size-within-alignment',
  'pe:pe32+:layout-and-structure:text-virtual-size-within-alignment',
  'macho:64:layout-and-structure:text-section-size-within-file-gap',
]);
const BYTE_HASH_RE = /^bytes:[0-9a-f]{32}$/;
const VALID_REBUILD_PROFILE_SUPPORT = new WeakSet();

const DISCOVERY_VALIDATOR = 'discovery-preservation';
export const REBUILD_DISCOVERY_MAX_BYTES = 16 * 1024 * 1024;
const DISCOVERY_TIMEOUT_MS = 10_000;
// Digests describe identities; they do not issue execution authority. Branding
// all execution objects also prevents a stripped discovery receipt from being
// replayed as a legacy receipt. Legacy factory flows do not gain a new validator.
const ISSUED_TRANSACTIONS = new WeakMap();
const ISSUED_MATERIALIZATIONS = new WeakMap();
const ISSUED_VALIDATIONS = new WeakMap();
const TYPED_ARRAY = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsicGet = (prototype, key, value) => Object.getOwnPropertyDescriptor(prototype, key).get.call(value);
const DISCOVERY_METADATA_LIMIT_FIELDS = Object.freeze({
  elf: new Set(['inputBytes', 'records', 'objects', 'stringBytes', 'operations', 'estimatedHeapBytes', 'wallClockMs']),
  pe: new Set(['inputBytes', 'records', 'objects', 'stringBytes', 'operations', 'estimatedHeapBytes', 'wallClockMs']),
  macho: new Set(['inputBytes', 'records', 'objects', 'stringBytes', 'operations', 'warnings', 'estimatedHeapBytes', 'wallClockMs']),
});
const DISCOVERY_BUDGET_FIELDS = new Set(['maxCandidates', 'maxEvidencePerCandidate']);
const DISCOVERY_ARTIFACT_BUDGET_FIELDS = new Set([
  'maxTotalEvidence', 'maxCandidateViews', 'maxProducerRuns', 'maxIntervalClaims', 'maxReferences', 'maxCollisionWork',
]);

function discoveryRequested(input) {
  return input.requireDiscoveryPreservation === true || input.discovery != null
    || input.discoveryArtifact != null || input.discoveryBinding != null
    || input.expectedOriginalState?.discovery != null || input.impact?.discovery === true
    || input.operations?.some((operation) => operation?.impact?.discovery === true)
    || input.additionalValidators?.includes(DISCOVERY_VALIDATOR) === true;
}

function discoveryLength(length, expected = null) {
  const n = typeof length === 'bigint' && length >= 0n && length <= BigInt(REBUILD_DISCOVERY_MAX_BYTES)
    ? Number(length) : length;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > REBUILD_DISCOVERY_MAX_BYTES) {
    throw new TypeError('rebuild-v2-discovery-byte-budget-exceeded');
  }
  if (expected != null && n !== expected) throw new TypeError('rebuild-v2-discovery-byte-length-mismatch');
  return n;
}

// Length is checked using intrinsic accessors BEFORE copies, element access,
// Array.from, or hashing. Shared backing cannot attest a stable byte snapshot.
function discoveryByteView(value, expected = null) {
  let buffer, offset = 0, length;
  if (ArrayBuffer.isView(value)) {
    const prototype = value instanceof DataView ? DataView.prototype : TYPED_ARRAY;
    length = intrinsicGet(prototype, 'byteLength', value);
    discoveryLength(length, expected);
    buffer = intrinsicGet(prototype, 'buffer', value);
    offset = intrinsicGet(prototype, 'byteOffset', value);
  } else if (value instanceof ArrayBuffer) {
    buffer = value;
    length = intrinsicGet(ArrayBuffer.prototype, 'byteLength', value);
    discoveryLength(length, expected);
  } else if (Array.isArray(value)) {
    length = discoveryLength(value.length, expected);
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      const byte = descriptor?.value;
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new TypeError('rebuild-v2-byte-invalid');
      }
      bytes[index] = byte;
    }
    return bytes;
  } else throw new TypeError('rebuild-v2-discovery-bytes-required');
  if (!(buffer instanceof ArrayBuffer)) throw new TypeError('rebuild-v2-discovery-shared-bytes-unsupported');
  return new Uint8Array(buffer, offset, length);
}

function sameDiscoveryBytes(value, expected) {
  const bytes = discoveryByteView(value, expected.length);
  return bytes.every((byte, index) => byte === expected[index]);
}

function discoveryControl(options) {
  const now = Date.now();
  const deadline = options.deadline ?? now + DISCOVERY_TIMEOUT_MS;
  if (typeof deadline !== 'number' || !Number.isSafeInteger(deadline)) throw new TypeError('rebuild-v2-discovery-deadline-invalid');
  return { signal: options.signal, deadline: Math.min(deadline, now + DISCOVERY_TIMEOUT_MS) };
}

function checkDiscoveryControl(control) {
  if (control.signal?.aborted) throw new Error('rebuild-v2-discovery-cancelled');
  if (Date.now() >= control.deadline) throw new Error('rebuild-v2-discovery-deadline-exceeded');
}

async function awaitDiscovery(control, action) {
  checkDiscoveryControl(control);
  let timer, abort;
  const stop = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('rebuild-v2-discovery-deadline-exceeded')), Math.max(1, control.deadline - Date.now()));
    abort = () => reject(new Error('rebuild-v2-discovery-cancelled'));
    control.signal?.addEventListener?.('abort', abort, { once: true });
  });
  try {
    const value = await Promise.race([Promise.resolve().then(() => { checkDiscoveryControl(control); return action(); }), stop]);
    checkDiscoveryControl(control);
    return value;
  } finally {
    clearTimeout(timer);
    control.signal?.removeEventListener?.('abort', abort);
  }
}

async function discoverySourceBytes(value, expected, control) {
  checkDiscoveryControl(control);
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    discoveryLength(intrinsicGet(Blob.prototype, 'size', value), expected);
    value = await awaitDiscovery(control, () => Blob.prototype.arrayBuffer.call(value));
  }
  return discoveryByteView(value, expected).slice();
}

function normalizeDiscoveryNumericRecord(value, fields, code) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(code);
  let prototype, descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError(code);
  }
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(code);
  const normalized = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !fields.has(key)) throw new TypeError(`${code}-key-invalid`);
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'number'
      || !Number.isSafeInteger(descriptor.value) || descriptor.value < 1) {
      throw new TypeError(`${code}-${key}-invalid`);
    }
    normalized[key] = descriptor.value;
  }
  return Object.freeze(normalized);
}

function normalizeDiscoveryMetadataLimits(format, value) {
  return normalizeDiscoveryNumericRecord(value, DISCOVERY_METADATA_LIMIT_FIELDS[format],
    'rebuild-v2-discovery-metadata-limits-invalid');
}

function normalizeDiscoveryParseBudget(value) {
  return normalizeDiscoveryNumericRecord(value, DISCOVERY_BUDGET_FIELDS, 'rebuild-v2-discovery-budget-invalid');
}

function normalizeDiscoveryArtifactBudget(value) {
  return normalizeDiscoveryNumericRecord(value, DISCOVERY_ARTIFACT_BUDGET_FIELDS,
    'rebuild-v2-discovery-artifact-budget-invalid');
}

async function parseDiscoveryBytes(transaction, bytes, sourceHash, snapshotId, control, options) {
  const { openBinary } = await import('../binary/index.js');
  const { functionCandidates, discoveryArtifactForRebuild } = await import('../analysis/index.js');
  const metadataLimits = normalizeDiscoveryMetadataLimits(transaction.format, options.discoveryMetadataLimits);
  const budget = normalizeDiscoveryParseBudget(options.discoveryBudget);
  const artifactBudget = normalizeDiscoveryArtifactBudget(options.discoveryArtifactBudget);
  checkDiscoveryControl(control);
  const image = openBinary(bytes.slice(), { signal: control.signal, metadataLimits });
  checkDiscoveryControl(control);
  if (image.format !== transaction.format || image.arch !== transaction.architecture || image.arch === 'unknown') {
    throw new Error('rebuild-v2-discovery-parser-identity-mismatch');
  }
  const metadata = image.metadata;
  // These are observations of OUR fresh parser, never caller metadata. A
  // warning-free bounded parse is deliberately narrower than loader success.
  const coverage = metadata?.[`${image.format}Metadata`];
  if (coverage?.complete !== true || coverage.reasons?.length || image.warnings?.length
    || metadata.peImports?.complete === false || metadata.exceptionDirectory?.invalidRecords > 0
    || metadata.programDynamicRelocationBudget?.stopped || metadata.programDynamicSymbolBudget?.stopped
    || metadata.programDynamic?.terminated === false || metadata.programDynamic?.entrySpanAligned === false
    || metadata.ehFrameHeader?.tableComplete === false || metadata.ehFrameHeader?.invalidEntries > 0) {
    throw new Error('rebuild-v2-discovery-parser-incomplete');
  }
  const binding = { binaryId: transaction.binaryId, sourceHash, snapshotId, architectureId: image.arch };
  const { artifact } = functionCandidates({ input: { image }, ...binding, signal: control.signal,
    budget, artifactBudget });
  const sourceBinding = discoveryArtifactForRebuild(artifact, binding);
  checkDiscoveryControl(control);
  return { artifact, sourceBinding };
}

function discoveryError(error, status = 'rejected') {
  const reason = String(error?.message || error);
  return { status: reason === 'rebuild-v2-discovery-cancelled' ? 'cancelled' : status, reason };
}

function required(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(code);
  return text;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  if (Array.isArray(value)) {
    for (const byte of value) {
      if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 0xff) throw new TypeError('rebuild-v2-byte-invalid');
    }
    return Uint8Array.from(value);
  }
  throw new TypeError('rebuild-v2-bytes-required');
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}

function hashBytes(value) {
  return `bytes:${stableDigest(Array.from(toBytes(value)))}`;
}

function sorted(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))].sort();
}

function canonicalHash(value, code = 'rebuild-v2-source-hash-invalid') {
  const text = required(value, code).toLowerCase();
  if (!BYTE_HASH_RE.test(text)) throw new TypeError(code);
  return text;
}

function optionalRecord(value, code) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError(code);
  return clone(value);
}

function canonicalTransactionId(transaction) {
  const payload = clone(transaction);
  payload.transactionId = null;
  return `rebuild-transaction:${stableDigest(payload)}`;
}

function canonicalOutputIdentity(transactionId, outputHash) {
  return `rebuild-output:${transactionId}:${outputHash}`;
}

function validationIdentityValid(validation) {
  try {
    if (!validation || typeof validation.validationId !== 'string') return false;
    const payload = clone(validation);
    delete payload.validationId;
    return validation.validationId === `rebuild-validation:${stableDigest(payload)}`;
  } catch {
    return false;
  }
}

function safeIndex(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function byteArrayValid(value) {
  return Array.isArray(value) && value.every((byte) => typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 0xff);
}

function operationShapeValid(operations) {
  if (!Array.isArray(operations) || operations.length === 0) return false;
  const ids = new Set();
  let previousEnd = 0n;
  let sizeDelta = 0;
  try {
    for (const operation of operations) {
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return false;
      if (typeof operation.id !== 'string' || operation.id.trim() === '' || ids.has(operation.id)) return false;
      ids.add(operation.id);
      const offset = explicitBigInt(operation.offset, 'rebuild-v2-offset-invalid');
      if (offset < 0n || !byteArrayValid(operation.before) || !byteArrayValid(operation.after) || (operation.before.length === 0 && operation.after.length === 0)) return false;
      if (offset < previousEnd) return false;
      previousEnd = offset + BigInt(operation.before.length);
      sizeDelta += operation.after.length - operation.before.length;
      if (!Number.isSafeInteger(sizeDelta)) return false;
      if (!operation.provenance || typeof operation.provenance !== 'object' || Array.isArray(operation.provenance)) return false;
    }
  } catch {
    return false;
  }
  return true;
}

function formatIdentityMismatch(result, transaction, expectedOutputHash) {
  if (!result || typeof result !== 'object') return null;
  const format = result.format ?? result.image?.format;
  if (format != null && String(format).toLowerCase() !== transaction.format) return 'validator-format-mismatch';
  const architecture = result.architecture ?? result.arch ?? result.image?.arch;
  if (architecture != null && String(architecture).toLowerCase() !== transaction.architecture) return 'validator-architecture-mismatch';
  const loaderVersion = result.loaderVersion ?? result.parserVersion ?? result.image?.loaderVersion;
  if (loaderVersion != null && String(loaderVersion) !== transaction.loaderVersion) return 'validator-loader-identity-mismatch';
  const sourceHash = result.sourceHash ?? result.inputHash ?? result.image?.sourceHash;
  if (sourceHash != null && String(sourceHash).toLowerCase() !== transaction.sourceHash) return 'validator-source-identity-mismatch';
  const outputHash = result.outputHash ?? result.bytesHash ?? result.image?.outputHash;
  if (outputHash != null && String(outputHash).toLowerCase() !== expectedOutputHash) return 'validator-output-identity-mismatch';
  return null;
}

function relocationResultFailure(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.bindingIntegrity === false || result.bindingsMatch === false || result.relocationBindingsMatch === false) return 'relocation-binding-mismatch';
  for (const key of ['unboundBindings', 'unresolvedBindings', 'mismatchedBindings', 'bindingMismatches', 'unresolvedRelocations']) {
    const value = result[key];
    if ((typeof value === 'number' && Number.isSafeInteger(value) && value > 0) || (Array.isArray(value) && value.length > 0)) return 'relocation-binding-mismatch';
  }
  return null;
}

function independentOracleResultFailure(result, context) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'independent-oracle-result-invalid';
  if (result.schemaVersion !== INDEPENDENT_ORACLE_RESULT_SCHEMA) return 'independent-oracle-contract-invalid';
  if (result.ok !== true || !['passed', 'valid'].includes(String(result.status || '').toLowerCase())) return 'independent-oracle-contract-invalid';
  for (const [field, reason] of [
    ['oracleIdentity', 'independent-oracle-identity-required'],
    ['oracleVersion', 'independent-oracle-version-required'],
    ['oracleSource', 'independent-oracle-source-required'],
    ['sourceDigest', 'independent-oracle-source-digest-required'],
    ['outputDigest', 'independent-oracle-output-digest-required'],
  ]) {
    if (typeof result[field] !== 'string' || result[field].trim() === '') return reason;
  }
  const loaderIdentity = String(context.transaction.loaderVersion || '').trim();
  if (result.oracleIdentity === loaderIdentity || result.oracleVersion === loaderIdentity || result.oracleSource === loaderIdentity) {
    return 'independent-oracle-identity-not-distinct';
  }
  const format = result.format ?? result.image?.format;
  if (typeof format !== 'string' || !format.trim()) return 'independent-oracle-format-required';
  if (format.toLowerCase() !== context.transaction.format) return 'independent-oracle-format-mismatch';
  const architecture = result.architecture ?? result.arch ?? result.image?.arch;
  if (typeof architecture !== 'string' || !architecture.trim()) return 'independent-oracle-architecture-required';
  if (architecture.toLowerCase() !== context.transaction.architecture) return 'independent-oracle-architecture-mismatch';
  if (result.sourceDigest !== context.transaction.sourceHash) return 'independent-oracle-source-digest-mismatch';
  if (result.outputDigest !== context.expectedOutputHash) return 'independent-oracle-output-digest-mismatch';
  const preservationKind = context.transaction.expectedOriginalState?.formatSafe?.kind;
  if (['elf-comment', 'pe-timestamp', 'macho-min-version'].includes(preservationKind) && result.preservationEvidence?.complete === true) {
    if (result.oracleIdentity !== F6_PRESERVATION_ORACLE_IDENTITY
      || typeof result.oracleVersion !== 'string' || !result.oracleVersion.includes(F6_PRESERVATION_ORACLE_VERSION)
      || typeof result.oracleSource !== 'string' || !/(?:^|[/\\])llvm-readobj(?:-\d+)?@sha256:[0-9a-f]{64}(?:\s|$)/.test(result.oracleSource)
      || typeof result.oracleOutputDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(result.oracleOutputDigest)) {
      return 'independent-oracle-preservation-provider-identity-invalid';
    }
  }
  return null;
}

function rebuildIdentityMatches(left, right) {
  return left?.binaryId === right?.binaryId
    && left?.format === right?.format
    && left?.architecture === right?.architecture
    && left?.loaderVersion === right?.loaderVersion
    && left?.sourceHash === right?.sourceHash;
}

function f6ProfileId(transaction) {
  if (transaction?.format === 'macho') return transaction.architecture === 'x86_64' || transaction.architecture === 'arm64' ? 'macho:64' : null;
  if (transaction?.format === 'elf') return transaction.architecture === 'x86_64' ? 'elf:64' : null;
  if (transaction?.format === 'pe') return transaction.architecture === 'x86' ? 'pe:pe32' : transaction.architecture === 'x86_64' ? 'pe:pe32+' : null;
  return null;
}

function f6Cell(profileId, unit, status, reason = null, evidence = null) {
  return Object.freeze({ id: `${profileId}:${unit}`, unit, status, reason, evidence });
}

function f6BoundedOperationCell(id, parentUnit, operation, status, reason = null, evidence = null) {
  return Object.freeze({ id, parentUnit, operation, status, reason, evidence });
}

export function f6KnownImplementationGaps() {
  return Object.freeze(F6_REBUILD_PROFILES.flatMap((profileId) => F6_UNIMPLEMENTED_OPERATION_UNITS.map((unit) => `${profileId}:${unit}`)));
}

function preservationEvidenceValid(transaction, validation) {
  const expected = transaction?.expectedOriginalState?.formatSafe;
  const expectedImpactSection = expected?.kind === 'elf-comment'
    ? expected.section
    : expected?.kind === 'pe-timestamp'
      ? expected.field
      : null;
  // The format-safe adapter currently represents Mach-O's command target with
  // a null impact section. Bind that representation as well: otherwise a
  // caller can rebind transaction/validation identities while changing the
  // claimed affected section and still inherit a preservation proof.
  const impactSections = transaction?.impact?.sections;
  const impactSectionMatches = expectedImpactSection == null
    ? Array.isArray(impactSections) && impactSections.length === 1 && impactSections[0] == null
    : Array.isArray(impactSections) && impactSections.length === 1 && impactSections[0] === expectedImpactSection;
  if (!['elf-comment','pe-timestamp','macho-min-version'].includes(expected?.kind)
    || expected.signaturePolicy !== 'unsigned-input-required'
    || !impactSectionMatches
    || transaction?.sizeDelta !== 0
    || transaction?.impact?.layoutMoving !== false
    || transaction?.impact?.relocations !== false
    || transaction?.impact?.branchRanges !== false
    || transaction?.impact?.unwind !== false
    || transaction?.impact?.importsExports !== false
    || transaction?.impact?.signature !== false
    || transaction?.impact?.relocationBindings?.length !== 0) return false;
  const formatResult = validation?.validators?.find((item) => item.validator === 'format-invariants');
  const oracleResult = validation?.validators?.find((item) => item.validator === 'independent-differential');
  const local = formatResult?.detail?.preservationEvidence;
  const independent = oracleResult?.detail?.preservationEvidence;
  const oracleDetail = oracleResult?.detail;
  const exactUnits = (value) => JSON.stringify(value || []) === JSON.stringify(F6_NATIVE_INVARIANT_UNITS);
  return formatResult?.status === 'passed'
    && oracleResult?.status === 'passed'
    && oracleDetail?.oracleIdentity === F6_PRESERVATION_ORACLE_IDENTITY
    && typeof oracleDetail?.oracleVersion === 'string'
    && oracleDetail.oracleVersion.includes(F6_PRESERVATION_ORACLE_VERSION)
    && typeof oracleDetail?.oracleSource === 'string'
    && /(?:^|[/\\])llvm-readobj(?:-\d+)?@sha256:[0-9a-f]{64}(?:\s|$)/.test(oracleDetail.oracleSource)
    && /^sha256:[0-9a-f]{64}$/.test(String(oracleDetail?.oracleOutputDigest || ''))
    && local?.complete === true
    && local?.signaturePolicy === 'unsigned-input-required'
    && local?.unchangedBytesExceptTarget === true
    && local?.unchangedStructure === true
    && exactUnits(local?.units)
    && independent?.complete === true
    && independent?.signaturePolicy === 'unsigned-input-required'
    && /^sha256:[0-9a-f]{64}$/.test(String(oracleResult?.detail?.oracleExecutableDigest || ''))
    && String(oracleResult?.detail?.oracleSource || '').includes(`@${oracleResult.detail.oracleExecutableDigest} `)
    && independent?.sourceReportDigest === independent?.outputReportDigest
    && /^sha256:[0-9a-f]{64}$/.test(String(independent?.sourceReportDigest || ''))
    && exactUnits(independent?.units);
}

function elfLayoutEvidenceValid(transaction, validation) {
  const expected = transaction?.expectedOriginalState?.formatSafe;
  if (transaction?.format !== 'elf' || transaction?.architecture !== 'x86_64'
    || expected?.schema !== 'hex-format-safe-rebuild/v1' || expected?.kind !== 'elf-add-nobits-section'
    || transaction?.impact?.layoutMoving !== true || transaction?.sizeDelta !== 64) return false;
  const formatResult = validation?.validators?.find((item) => item.validator === 'format-invariants');
  const layoutResult = validation?.validators?.find((item) => item.validator === 'layout');
  const oracleResult = validation?.validators?.find((item) => item.validator === 'independent-differential');
  const matches = (evidence) => evidence?.sectionCount === expected.outputSectionCount
    && evidence?.section?.name === expected.section
    && evidence?.section?.type === expected.type
    && evidence?.section?.size === expected.size
    && evidence?.section?.alignment === expected.alignment;
  return formatResult?.status === 'passed' && layoutResult?.status === 'passed'
    && oracleResult?.status === 'passed'
    && matches(formatResult.detail?.layoutEvidence)
    && matches(layoutResult.detail?.layoutEvidence)
    && matches(oracleResult.detail?.layoutEvidence);
}

function peLayoutEvidenceValid(transaction, validation) {
  const expected = transaction?.expectedOriginalState?.formatSafe;
  if (transaction?.format !== 'pe' || !['x86', 'x86_64'].includes(transaction?.architecture)
    || expected?.schema !== 'hex-format-safe-rebuild/v1' || expected?.kind !== 'pe-section-virtual-size'
    || transaction?.impact?.layoutMoving !== true || transaction?.sizeDelta !== 0
    || expected?.section !== '.text' || expected?.sourceSectionCount !== expected?.outputSectionCount) return false;
  const formatResult = validation?.validators?.find((item) => item.validator === 'format-invariants');
  const layoutResult = validation?.validators?.find((item) => item.validator === 'layout');
  const oracleResult = validation?.validators?.find((item) => item.validator === 'independent-differential');
  const matches = (evidence) => evidence?.sectionCount === expected.outputSectionCount
    && evidence?.section?.index === expected.sectionIndex
    && evidence?.section?.name === expected.section
    && evidence?.section?.virtualAddress === expected.virtualAddress
    && evidence?.section?.rawSize === expected.rawSize
    && evidence?.section?.originalVirtualSize === expected.originalVirtualSize
    && evidence?.section?.virtualSize === expected.virtualSize
    && evidence?.section?.sectionAlignment === expected.sectionAlignment
    && evidence?.section?.sizeOfImage === expected.outputSizeOfImage;
  return formatResult?.status === 'passed' && layoutResult?.status === 'passed'
    && oracleResult?.status === 'passed'
    && matches(formatResult.detail?.layoutEvidence)
    && matches(layoutResult.detail?.layoutEvidence)
    && matches(oracleResult.detail?.layoutEvidence);
}

function machoLayoutEvidenceValid(transaction, validation) {
  const expected = transaction?.expectedOriginalState?.formatSafe;
  if (transaction?.format !== 'macho' || transaction?.architecture !== 'x86_64'
    || expected?.schema !== 'hex-format-safe-rebuild/v1' || expected?.kind !== 'macho-section-size'
    || transaction?.impact?.layoutMoving !== true || transaction?.sizeDelta !== 0
    || expected?.segment !== '__TEXT' || expected?.section !== '__text'
    || expected?.sourceSectionCount !== expected?.outputSectionCount) return false;
  const formatResult = validation?.validators?.find((item) => item.validator === 'format-invariants');
  const layoutResult = validation?.validators?.find((item) => item.validator === 'layout');
  const oracleResult = validation?.validators?.find((item) => item.validator === 'independent-differential');
  const matches = (evidence) => evidence?.sectionCount === expected.outputSectionCount
    && evidence?.segment?.commandIndex === expected.segmentCommandIndex
    && evidence?.segment?.name === expected.segment
    && evidence?.segment?.fileOffset === expected.segmentFileOffset
    && evidence?.segment?.fileSize === expected.segmentFileSize
    && evidence?.segment?.sectionCount === expected.outputSectionCount
    && evidence?.section?.index === expected.sectionIndex
    && evidence?.section?.segment === expected.segment
    && evidence?.section?.name === expected.section
    && evidence?.section?.offset === expected.sectionOffset
    && evidence?.section?.originalSize === expected.originalSize
    && evidence?.section?.size === expected.size
    && evidence?.section?.nextSectionOffset === expected.nextSectionOffset;
  return formatResult?.status === 'passed' && layoutResult?.status === 'passed'
    && oracleResult?.status === 'passed'
    && matches(formatResult.detail?.layoutEvidence)
    && matches(layoutResult.detail?.layoutEvidence)
    && matches(oracleResult.detail?.layoutEvidence);
}

/**
 * Evaluate F6's locked unit vocabulary against the actual v2 transaction
 * evidence.  A generic validator result or denominator identity is not an
 * implementation of a native rewrite class: layout growth, relocation,
 * branch, unwind, import/export, and signature consequences remain blocking
 * until a format-aware production adapter and focused evidence exist. The
 * evaluator reports those blockers instead of allowing profile-level proof to
 * promote them.
 */
export function evaluateF6RebuildDenominator({ transaction, validation, publication, proof = {} } = {}) {
  const profileId = f6ProfileId(transaction);
  const prefix = profileId || `${transaction?.format || 'unknown'}:unknown`;
  const cells = {};
  const boundedOperationCells = {};
  const add = (unit, status, reason = null, evidence = null) => { cells[unit] = f6Cell(prefix, unit, status, reason, evidence); };
  if (!profileId) {
    for (const unit of F6_REBUILD_UNITS) add(unit, 'blocking', 'f6-profile-unsupported');
    return Object.freeze({ status: 'blocked', profileId: null, cells: Object.freeze(cells), boundedOperationCells: Object.freeze(boundedOperationCells), boundedOperationClosedIds: Object.freeze([]), boundedOperationBlockingIds: Object.freeze([]), closedUnitIds: Object.freeze([]), blockingUnitIds: Object.freeze(F6_REBUILD_UNITS.map((unit) => `${prefix}:${unit}`)), blockers: Object.freeze(['f6-profile-unsupported']) });
  }

  const validationPassed = transactionIdentityValid(transaction)
    && validation?.status === 'valid'
    && validation?.allRequiredExecuted === true
    && validation?.transactionId === transaction?.transactionId
    && rebuildIdentityMatches(validation, transaction)
    && validationIdentityValid(validation);
  const publicationComplete = publication?.status === 'published'
    && publication.atomic === true
    && publication.committed === true
    && publication.transactionId === transaction?.transactionId
    && publication.outputHash === validation?.outputHash
    && publication.outputIdentity === validation?.outputIdentity
    && ATOMIC_PUBLICATION_PROTOCOLS.has(publication.protocol)
    && !!publication.publicationIdentity;
  add('transaction-identity', validationPassed ? 'closed' : 'blocking', validationPassed ? null : 'f6-transaction-identity-unproven', validationPassed ? 'transaction-v2-validation-identity' : null);

  const preservationProof = validationPassed
    && publicationComplete
    && proof.realFixture === true
    && proof.realFixtureEvidence === true
    && proof.negativeValidatorTest === true
    && proof.staleIdentityTest === true
    && proof.truncationTest === true
    && proof.wrongIdentityTest === true
    && preservationEvidenceValid(transaction, validation);
  for (const unit of F6_NATIVE_INVARIANT_UNITS) add(
    unit,
    preservationProof ? 'closed' : 'blocking',
    preservationProof ? null : 'f6-preservation-profile-proof-incomplete',
    preservationProof ? 'format-safe-unsigned-preservation+hex-whole-file-invariants+llvm-readobj-all-source-output-oracle' : null,
  );
  const boundedLayoutProof = validationPassed
    && publicationComplete
    && proof.realFixture === true
    && proof.realFixtureEvidence === true
    && proof.negativeValidatorTest === true
    && proof.staleIdentityTest === true
    && proof.truncationTest === true
    && proof.wrongIdentityTest === true
    && elfLayoutEvidenceValid(transaction, validation);
  if (profileId === 'elf:64') {
    const boundedId = F6_BOUNDED_OPERATION_CELLS[0];
    boundedOperationCells[boundedId] = f6BoundedOperationCell(
      boundedId,
      'layout-and-structure',
      'elf-add-nobits-section',
      boundedLayoutProof ? 'closed' : 'blocking',
      boundedLayoutProof ? null : 'f6-bounded-elf-layout-proof-incomplete',
      boundedLayoutProof ? 'format-safe-elf-add-nobits-section+hex-loader-reparse+llvm-readobj-independent-oracle+atomic-publication' : null,
    );
  }
  if (profileId === 'pe:pe32' || profileId === 'pe:pe32+') {
    const boundedId = F6_BOUNDED_OPERATION_CELLS.find((id) => id.startsWith(`${profileId}:`));
    const peLayoutProof = validationPassed
      && publicationComplete
      && proof.realFixture === true
      && proof.realFixtureEvidence === true
      && proof.negativeValidatorTest === true
      && proof.staleIdentityTest === true
      && proof.truncationTest === true
      && proof.wrongIdentityTest === true
      && peLayoutEvidenceValid(transaction, validation);
    boundedOperationCells[boundedId] = f6BoundedOperationCell(
      boundedId,
      'layout-and-structure',
      'pe-section-virtual-size',
      peLayoutProof ? 'closed' : 'blocking',
      peLayoutProof ? null : 'f6-bounded-pe-layout-proof-incomplete',
      peLayoutProof ? 'format-safe-pe-section-virtual-size+hex-loader-reparse+llvm-readobj-independent-oracle+atomic-publication' : null,
    );
  }
  if (profileId === 'macho:64') {
    const boundedId = F6_BOUNDED_OPERATION_CELLS.find((id) => id.startsWith(`${profileId}:`));
    const machoLayoutProof = validationPassed
      && publicationComplete
      && proof.realFixture === true
      && proof.realFixtureEvidence === true
      && proof.negativeValidatorTest === true
      && proof.staleIdentityTest === true
      && proof.truncationTest === true
      && proof.wrongIdentityTest === true
      && machoLayoutEvidenceValid(transaction, validation);
    boundedOperationCells[boundedId] = f6BoundedOperationCell(
      boundedId,
      'layout-and-structure',
      'macho-section-size',
      machoLayoutProof ? 'closed' : 'blocking',
      machoLayoutProof ? null : 'f6-bounded-macho-layout-proof-incomplete',
      machoLayoutProof ? 'format-safe-macho-section-size+hex-loader-reparse+llvm-readobj-independent-oracle+atomic-publication' : null,
    );
  }
  if (profileId === 'elf:64' && elfLayoutEvidenceValid(transaction, validation)) {
    add('layout-and-structure', 'blocking', 'f6-layout-and-structure-profile-matrix-incomplete', 'elf64-terminal-section-table-nobits-adapter+llvm-readobj-section-oracle');
  }

  const loader = validation?.validators?.find((item) => item.validator === 'loader-reparse');
  add('loader-reparse', loader?.status === 'passed' ? 'closed' : 'blocking', loader?.status === 'passed' ? null : 'f6-loader-reparse-unproven', loader?.status === 'passed' ? 'production-loader-reparse' : null);
  const independent = validation?.validators?.find((item) => item.validator === 'independent-differential');
  add('independent-differential-oracle', independent?.status === 'passed' && validation?.independentDifferential === 'executed' ? 'closed' : 'blocking', independent?.status === 'passed' && validation?.independentDifferential === 'executed' ? null : 'f6-independent-oracle-unproven', independent?.status === 'passed' ? 'independent-oracle-contract' : null);

  add('atomic-publication', publicationComplete ? 'closed' : 'blocking', publicationComplete ? null : 'f6-atomic-publication-unproven', publicationComplete ? 'transaction-v2-publication-identity' : null);
  add('real-fixture', proof.realFixture === true && proof.realFixtureEvidence === true ? 'closed' : 'blocking', proof.realFixture === true && proof.realFixtureEvidence === true ? null : 'f6-real-fixture-evidence-unproven', proof.realFixture === true && proof.realFixtureEvidence === true ? 'compiler-produced-fixture' : null);
  const negativeEvidence = proof.negativeValidatorTest === true
    && proof.staleIdentityTest === true
    && proof.truncationTest === true
    && proof.wrongIdentityTest === true;
  add('negative-validator-corpus', negativeEvidence ? 'closed' : 'blocking', negativeEvidence ? null : 'f6-negative-validator-evidence-incomplete', negativeEvidence ? 'tamper-truncation-identity-negative-corpus' : null);

  const entries = Object.values(cells);
  const boundedEntries = Object.values(boundedOperationCells);
  const closedUnitIds = entries.filter((item) => item.status === 'closed').map((item) => item.id);
  const blockingUnitIds = entries.filter((item) => item.status !== 'closed').map((item) => item.id);
  const boundedOperationClosedIds = boundedEntries.filter((item) => item.status === 'closed').map((item) => item.id);
  const boundedOperationBlockingIds = boundedEntries.filter((item) => item.status !== 'closed').map((item) => item.id);
  return Object.freeze({
    status: blockingUnitIds.length === 0 ? 'closed' : 'blocked',
    profileId,
    cells: Object.freeze(cells),
    boundedOperationCells: Object.freeze(boundedOperationCells),
    boundedOperationClosedIds: Object.freeze(boundedOperationClosedIds),
    boundedOperationBlockingIds: Object.freeze(boundedOperationBlockingIds),
    closedUnitIds: Object.freeze(closedUnitIds),
    blockingUnitIds: Object.freeze(blockingUnitIds),
    blockers: Object.freeze(entries.filter((item) => item.status !== 'closed').map((item) => item.reason)),
  });
}

function positiveSafe(value, fallback, max, code) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new TypeError(code);
  return n;
}

function explicitBigInt(value, code) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(code);
    return BigInt(value);
  }
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && value.trim()) return BigInt(value);
  throw new TypeError(code);
}

function requiredValidators(impact, additional = [], requireIndependentOracle = false) {
  const set = new Set(['source-precondition', 'structure', 'loader-reparse', 'unchanged-regions', 'evidence']);
  if (impact.layoutMoving) set.add('layout');
  if (impact.relocations) set.add('relocations');
  if (impact.branchRanges) set.add('branch-ranges');
  if (impact.unwind) set.add('unwind');
  if (impact.importsExports) set.add('imports-exports');
  if (impact.signature) set.add('signature-consequence');
  for (const item of additional) set.add(String(item));
  if (requireIndependentOracle) set.add('independent-differential');
  return [...set].sort();
}

export function createRebuildTransaction(input = {}) {
  if (!Array.isArray(input.operations) || input.operations.length === 0) throw new TypeError('rebuild-v2-operations-required');
  const needsDiscovery = discoveryRequested(input);
  const discoverySourceLength = needsDiscovery ? discoveryLength(input.sourceLength ?? input.discovery?.sourceLength) : null;
  const operations = input.operations.map((operation, index) => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw new TypeError('rebuild-v2-operation-invalid');
    const offset = explicitBigInt(operation.offset ?? operation.fileOffset ?? -1, 'rebuild-v2-offset-invalid');
    if (offset < 0n) throw new TypeError('rebuild-v2-offset-invalid');
    if (needsDiscovery) {
      discoveryByteView(operation.before ?? []);
      discoveryByteView(operation.after ?? []);
    }
    const before = toBytes(operation.before ?? []);
    const after = toBytes(operation.after ?? []);
    if (before.length === 0 && after.length === 0) throw new TypeError('rebuild-v2-empty-operation');
    return {
      id: required(operation.id ?? `operation:${index}:${stableDigest({ offset: offset.toString(), before: Array.from(before), after: Array.from(after) })}`, 'rebuild-v2-operation-id-required'),
      offset: offset.toString(),
      before: Array.from(before),
      after: Array.from(after),
      address: operation.address == null ? null : String(operation.address),
      provenance: clone(operation.provenance || { source: 'local-patch' }),
    };
  }).sort((a, b) => BigInt(a.offset) < BigInt(b.offset) ? -1 : BigInt(a.offset) > BigInt(b.offset) ? 1 : a.id.localeCompare(b.id));

  for (let index = 1; index < operations.length; index++) {
    const previous = operations[index - 1];
    const current = operations[index];
    const previousEnd = BigInt(previous.offset) + BigInt(previous.before.length);
    if (BigInt(current.offset) < previousEnd) throw new TypeError('rebuild-v2-overlapping-original-ranges');
  }

  const sizeDelta = operations.reduce((sum, operation) => sum + operation.after.length - operation.before.length, 0);
  if (!Number.isSafeInteger(sizeDelta)) throw new TypeError('rebuild-v2-size-delta-invalid');
  const operationIds = new Set();
  for (const operation of operations) {
    if (operationIds.has(operation.id)) throw new TypeError('rebuild-v2-duplicate-operation-id');
    operationIds.add(operation.id);
  }
  const declaredImpact = input.impact || {};
  if (typeof declaredImpact !== 'object' || Array.isArray(declaredImpact)) throw new TypeError('rebuild-v2-impact-invalid');
  const format = required(input.format, 'rebuild-v2-format-required').toLowerCase();
  if (!REBUILD_FORMATS.has(format)) throw new TypeError('rebuild-v2-format-unsupported');
  const architecture = required(input.architecture, 'rebuild-v2-architecture-required').toLowerCase();
  const sourceHash = canonicalHash(input.sourceHash);
  const loaderVersion = required(input.loaderVersion, 'rebuild-v2-loader-version-required');
  const explicitDiscoveryBinding = input.discoveryBinding ?? null;
  const expectedDiscoveryBinding = input.expectedOriginalState?.discovery ?? null;
  for (const binding of [explicitDiscoveryBinding, expectedDiscoveryBinding]) {
    if (binding != null && !isFactoryIssuedDiscoveryRebuildBinding(binding)) {
      throw new TypeError('rebuild-v2-discovery-binding-unissued');
    }
  }
  if (explicitDiscoveryBinding != null && expectedDiscoveryBinding != null
    && explicitDiscoveryBinding.digest !== expectedDiscoveryBinding.digest) {
    throw new TypeError('rebuild-v2-discovery-binding-mismatch');
  }
  let suppliedDiscovery = explicitDiscoveryBinding ?? expectedDiscoveryBinding;
  if (input.discoveryArtifact != null) {
    const artifactBinding = discoveryArtifactForRebuild(input.discoveryArtifact);
    if (suppliedDiscovery && suppliedDiscovery.digest !== artifactBinding.digest) throw new TypeError('rebuild-v2-discovery-binding-mismatch');
    suppliedDiscovery = artifactBinding;
  }
  let discovery = null;
  if (needsDiscovery) {
    const snapshotId = input.snapshotId ?? input.discovery?.snapshotId ?? suppliedDiscovery?.binding.snapshotId;
    if (typeof snapshotId !== 'string' || !snapshotId.trim()) throw new TypeError('rebuild-v2-discovery-snapshot-required');
    const expectedBinding = { binaryId: input.binaryId, sourceHash, snapshotId, architectureId: architecture };
    for (const [key, value] of Object.entries(expectedBinding)) {
      if (suppliedDiscovery && suppliedDiscovery.binding[key] !== value) throw new TypeError(`rebuild-v2-discovery-${key}-mismatch`);
    }
    discovery = { schemaVersion: 'hex-rebuild-discovery-contract-v1', required: true,
      scope: 'fixed-metadata-v1', parserIdentity: 'hex-loader:openBinary:v1', snapshotId,
      sourceLength: discoverySourceLength, outputLength: discoveryLength(discoverySourceLength + sizeDelta),
      maxBytes: REBUILD_DISCOVERY_MAX_BYTES, sourceArtifactId: suppliedDiscovery?.artifactId ?? null };
  }
  const expectedOriginalState = optionalRecord(input.expectedOriginalState || { sourceHash }, 'rebuild-v2-original-state-invalid');
  if (expectedOriginalState.sourceHash != null && canonicalHash(expectedOriginalState.sourceHash) !== sourceHash) throw new TypeError('rebuild-v2-original-state-identity-mismatch');
  expectedOriginalState.sourceHash = sourceHash;
  const relocationBindings = input.relocationBindings ?? declaredImpact.relocationBindings ?? [];
  if (!Array.isArray(relocationBindings)) throw new TypeError('rebuild-v2-relocation-bindings-invalid');
  const impact = {
    layoutMoving: sizeDelta !== 0 || declaredImpact.layoutMoving === true,
    relocations: declaredImpact.relocations === true || relocationBindings.length > 0,
    branchRanges: declaredImpact.branchRanges === true,
    unwind: declaredImpact.unwind === true,
    importsExports: declaredImpact.importsExports === true,
    signature: declaredImpact.signature === true,
    sections: clone(declaredImpact.sections || []),
    relocationBindings: clone(relocationBindings),
  };
  const requireIndependentOracle = input.requireIndependentOracle === true;
  const transaction = {
    schemaVersion: REBUILD_TRANSACTION_SCHEMA,
    transactionId: null,
    binaryId: required(input.binaryId, 'rebuild-v2-binary-id-required'),
    sourceHash,
    format,
    architecture,
    loaderVersion,
    operations: clone(operations),
    sizeDelta,
    impact,
    relocationBindings: clone(relocationBindings),
    expectedOriginalState,
    requiredValidators: requiredValidators(impact, [...(input.additionalValidators || []), ...(needsDiscovery ? [DISCOVERY_VALIDATOR] : [])], requireIndependentOracle),
    ...(discovery ? { discovery } : {}),
    requireIndependentOracle,
    unresolvedRisks: sorted(input.unresolvedRisks),
    authority: 'L3-explicit-rebuild-proposal',
  };
  transaction.transactionId = `rebuild-transaction:${stableDigest(transaction)}`;
  deepFreeze(transaction);
  ISSUED_TRANSACTIONS.set(transaction, { discovery, suppliedDiscovery });
  return transaction;
}

async function sourceBytes(source) {
  if (typeof Blob !== 'undefined' && source instanceof Blob) return new Uint8Array(await source.arrayBuffer());
  return toBytes(source).slice();
}

function transactionIdentityValid(transaction) {
  try {
    if (!transaction || !ISSUED_TRANSACTIONS.has(transaction) || transaction.schemaVersion !== REBUILD_TRANSACTION_SCHEMA) return false;
    if (!REBUILD_FORMATS.has(String(transaction.format || '').toLowerCase())) return false;
    if (String(transaction.format).toLowerCase() !== transaction.format) return false;
    if (!BYTE_HASH_RE.test(String(transaction.sourceHash || '').toLowerCase())) return false;
    if (String(transaction.sourceHash).toLowerCase() !== transaction.sourceHash) return false;
    if (!transaction.loaderVersion || !transaction.binaryId || !transaction.architecture) return false;
    if (!operationShapeValid(transaction.operations)) return false;
    const computedDelta = transaction.operations.reduce((sum, operation) => sum + operation.after.length - operation.before.length, 0);
    if (!Number.isSafeInteger(transaction.sizeDelta) || transaction.sizeDelta !== computedDelta) return false;
    if (!Array.isArray(transaction.requiredValidators) || transaction.requiredValidators.length === 0) return false;
    if (!Array.isArray(transaction.impact?.relocationBindings)) return false;
    if (!Array.isArray(transaction.relocationBindings) || stableDigest(transaction.relocationBindings) !== stableDigest(transaction.impact.relocationBindings)) return false;
    if (!Array.isArray(transaction.impact?.sections)) return false;
    if (typeof transaction.impact.layoutMoving !== 'boolean' || typeof transaction.impact.relocations !== 'boolean' || typeof transaction.impact.branchRanges !== 'boolean' || typeof transaction.impact.unwind !== 'boolean' || typeof transaction.impact.importsExports !== 'boolean' || typeof transaction.impact.signature !== 'boolean') return false;
    if (transaction.expectedOriginalState?.sourceHash !== transaction.sourceHash) return false;
    const expected = requiredValidators(transaction.impact, transaction.requiredValidators.filter((name) => ![
      'source-precondition', 'structure', 'loader-reparse', 'unchanged-regions', 'evidence',
      'layout', 'relocations', 'branch-ranges', 'unwind', 'imports-exports', 'signature-consequence', 'independent-differential',
    ].includes(name)), transaction.requireIndependentOracle === true);
    if (JSON.stringify(expected) !== JSON.stringify(transaction.requiredValidators)) return false;
    if (canonicalTransactionId(transaction) !== transaction.transactionId) return false;
    return true;
  } catch {
    return false;
  }
}

function materializationIdentityValid(transaction, materialized, original) {
  try {
    if (!materialized || ISSUED_MATERIALIZATIONS.get(materialized)?.transaction !== transaction
      || materialized.status !== 'materialized' || materialized.transactionId !== transaction.transactionId) return false;
    if (materialized.sourceHash !== transaction.sourceHash) return false;
    if (materialized.binaryId !== transaction.binaryId || materialized.format !== transaction.format || materialized.architecture !== transaction.architecture || materialized.loaderVersion !== transaction.loaderVersion) return false;
    if (!Number.isSafeInteger(materialized.sourceLength) || materialized.sourceLength !== original.length) return false;
    if (!Number.isSafeInteger(materialized.outputLength)) return false;
    if (!Number.isSafeInteger(materialized.sizeDelta) || materialized.sizeDelta !== transaction.sizeDelta) return false;
    if (!materialized.bytes || !ArrayBuffer.isView(materialized.bytes)) return false;
    const output = toBytes(materialized.bytes);
    if (materialized.outputLength !== output.length || materialized.outputLength !== materialized.sourceLength + transaction.sizeDelta) return false;
    if (materialized.outputHash !== hashBytes(output)) return false;
    if (materialized.outputIdentity !== canonicalOutputIdentity(transaction.transactionId, materialized.outputHash)) return false;
    return mappingsMatchTransaction(transaction, materialized.mappings, original.length, output.length)
      && relocationBindingsMatchMaterialization(transaction, materialized);
  } catch {
    return false;
  }
}

function mappingsMatchTransaction(transaction, mappings, sourceLength, outputLength) {
  if (!Array.isArray(mappings)) return false;
  let sourceCursor = 0;
  let outputCursor = 0;
  let operationIndex = 0;
  for (const mapping of mappings) {
    if (!mapping || typeof mapping !== 'object' || !safeIndex(mapping.sourceOffset) || !safeIndex(mapping.outputOffset)) return false;
    if (mapping.sourceOffset !== sourceCursor || mapping.outputOffset !== outputCursor) return false;
    if (mapping.kind === 'unchanged') {
      if (!safeIndex(mapping.length) || mapping.length > sourceLength - sourceCursor || mapping.length > outputLength - outputCursor) return false;
      sourceCursor += mapping.length;
      outputCursor += mapping.length;
      continue;
    }
    if (mapping.kind !== 'operation' || operationIndex >= transaction.operations.length) return false;
    const operation = transaction.operations[operationIndex++];
    if (mapping.operationId !== operation.id || mapping.sourceOffset !== Number(BigInt(operation.offset))) return false;
    if (!safeIndex(mapping.beforeLength) || !safeIndex(mapping.afterLength) || mapping.beforeLength !== operation.before.length || mapping.afterLength !== operation.after.length) return false;
    if (mapping.beforeLength > sourceLength - sourceCursor || mapping.afterLength > outputLength - outputCursor) return false;
    sourceCursor += mapping.beforeLength;
    outputCursor += mapping.afterLength;
  }
  return operationIndex === transaction.operations.length && sourceCursor === sourceLength && outputCursor === outputLength;
}

function mappedOutputOffset(mappings, sourceOffset) {
  for (const mapping of mappings || []) {
    if (mapping.kind === 'unchanged' && sourceOffset >= mapping.sourceOffset && sourceOffset <= mapping.sourceOffset + mapping.length) return mapping.outputOffset + (sourceOffset - mapping.sourceOffset);
    if (mapping.kind === 'operation' && sourceOffset === mapping.sourceOffset) return mapping.outputOffset;
  }
  return null;
}

function relocationBindingsMatchMaterialization(transaction, materialized) {
  const bindings = transaction.impact?.relocationBindings || [];
  for (const binding of bindings) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return false;
    let sourceOffset = null;
    try {
      const candidate = binding.sourceOffset ?? binding.fileOffset ?? binding.offset;
      if (candidate != null) sourceOffset = explicitBigInt(candidate, 'rebuild-v2-relocation-offset-invalid');
    } catch {
      return false;
    }
    if (sourceOffset == null || sourceOffset < 0n) continue;
    const sourceNumber = Number(sourceOffset);
    if (!Number.isSafeInteger(sourceNumber) || sourceNumber > materialized.sourceLength) return false;
    const mapped = mappedOutputOffset(materialized.mappings, sourceNumber);
    if (mapped == null) return false;
    if (binding.outputOffset != null) {
      try {
        if (explicitBigInt(binding.outputOffset, 'rebuild-v2-relocation-output-offset-invalid') !== BigInt(mapped)) return false;
      } catch {
        return false;
      }
    }
    const width = binding.width ?? binding.size ?? binding.length;
    if (width != null) {
      try {
        const n = explicitBigInt(width, 'rebuild-v2-relocation-width-invalid');
        if (n <= 0n || n > BigInt(materialized.sourceLength) - sourceOffset) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}

export async function materializeRebuildTransaction(transaction, source, options = {}) {
  if (!transaction || transaction.schemaVersion !== REBUILD_TRANSACTION_SCHEMA) return { status: 'rejected', reason: 'rebuild-v2-transaction-schema-invalid' };
  if (!transactionIdentityValid(transaction)) return { status: 'rejected', reason: 'rebuild-v2-transaction-identity-invalid', transactionId: transaction.transactionId || null };
  if (options.signal?.aborted) return { status: 'cancelled', reason: 'rebuild-v2-cancelled-before-materialization', transactionId: transaction.transactionId };
  const issued = ISSUED_TRANSACTIONS.get(transaction);
  let control, sourceDiscovery;
  let original;
  try {
    if (issued.discovery) {
      control = discoveryControl(options);
      original = await discoverySourceBytes(source, issued.discovery.sourceLength, control);
    } else original = await sourceBytes(source);
  }
  catch (error) { if (issued.discovery) return discoveryError(error); return { status: 'rejected', reason: 'rebuild-v2-source-unavailable', detail: String(error?.message || error), transactionId: transaction.transactionId }; }
  const observedHash = hashBytes(original);
  if (observedHash !== transaction.sourceHash) return { status: 'rejected', reason: 'rebuild-v2-source-identity-mismatch', expected: transaction.sourceHash, observed: observedHash, transactionId: transaction.transactionId };

  if (issued.discovery) {
    try {
      sourceDiscovery = await awaitDiscovery(control, () => parseDiscoveryBytes(transaction, original,
        observedHash, issued.discovery.snapshotId, control, options));
      if (issued.suppliedDiscovery) {
        const comparison = verifyDiscoveryReparse(issued.suppliedDiscovery, sourceDiscovery.artifact, { expectedOutputHash: observedHash });
        if (!comparison.ok) return { status: 'rejected', reason: comparison.reason };
      }
    } catch (error) { return discoveryError(error); }
  }
  const finalLength = original.length + transaction.sizeDelta;
  const defaultBudget = Math.min(Math.max(original.length * 4 + 1024 * 1024, 16 * 1024 * 1024), 2_147_483_647);
  let maxOutputBytes;
  try { maxOutputBytes = positiveSafe(options.maxOutputBytes, defaultBudget, 2_147_483_647, 'rebuild-v2-max-output-budget-invalid'); }
  catch { return { status: 'rejected', reason: 'rebuild-v2-max-output-budget-invalid' }; }
  if (!Number.isSafeInteger(finalLength) || finalLength < 0 || finalLength > maxOutputBytes) return { status: 'rejected', reason: 'rebuild-v2-output-budget-exceeded', finalLength, maxOutputBytes };

  const output = new Uint8Array(finalLength);
  const mappings = [];
  let sourceCursor = 0;
  let outputCursor = 0;
  for (const operation of transaction.operations) {
    if (options.signal?.aborted) return { status: 'cancelled', reason: 'rebuild-v2-cancelled-during-materialization', transactionId: transaction.transactionId };
    const offset = Number(BigInt(operation.offset));
    if (!Number.isSafeInteger(offset) || offset < sourceCursor || offset > original.length) return { status: 'rejected', reason: 'rebuild-v2-operation-out-of-range', operationId: operation.id };
    const before = Uint8Array.from(operation.before);
    const after = Uint8Array.from(operation.after);
    if (offset + before.length > original.length) return { status: 'rejected', reason: 'rebuild-v2-operation-out-of-range', operationId: operation.id };
    for (let i = 0; i < before.length; i++) if (original[offset + i] !== before[i]) return { status: 'rejected', reason: 'rebuild-v2-original-precondition-mismatch', operationId: operation.id, byteIndex: i };

    const untouchedLength = offset - sourceCursor;
    output.set(original.subarray(sourceCursor, offset), outputCursor);
    if (untouchedLength > 0) mappings.push({ kind: 'unchanged', sourceOffset: sourceCursor, outputOffset: outputCursor, length: untouchedLength });
    outputCursor += untouchedLength;
    output.set(after, outputCursor);
    mappings.push({ kind: 'operation', operationId: operation.id, sourceOffset: offset, outputOffset: outputCursor, beforeLength: before.length, afterLength: after.length });
    outputCursor += after.length;
    sourceCursor = offset + before.length;
  }
  const tailLength = original.length - sourceCursor;
  output.set(original.subarray(sourceCursor), outputCursor);
  if (tailLength > 0) mappings.push({ kind: 'unchanged', sourceOffset: sourceCursor, outputOffset: outputCursor, length: tailLength });
  outputCursor += tailLength;
  if (outputCursor !== output.length) return { status: 'rejected', reason: 'rebuild-v2-materialization-length-mismatch' };

  if (control) {
    try { checkDiscoveryControl(control); } catch (error) { return discoveryError(error); }
  }
  const materialized = deepFreeze({
    status: 'materialized',
    transactionId: transaction.transactionId,
    binaryId: transaction.binaryId,
    format: transaction.format,
    architecture: transaction.architecture,
    loaderVersion: transaction.loaderVersion,
    sourceHash: observedHash,
    outputHash: hashBytes(output),
    outputIdentity: canonicalOutputIdentity(transaction.transactionId, hashBytes(output)),
    requiredValidators: [...transaction.requiredValidators],
    sourceLength: original.length,
    outputLength: output.length,
    sizeDelta: transaction.sizeDelta,
    bytes: output,
    mappings,
    temporary: true,
    publication: 'not-published',
    ...(sourceDiscovery ? { discovery: { contract: issued.discovery, sourceBinding: sourceDiscovery.sourceBinding } } : {}),
  });
  if (control) {
    try { checkDiscoveryControl(control); } catch (error) { return discoveryError(error); }
  }
  ISSUED_MATERIALIZATIONS.set(materialized, { transaction, discovery: issued.discovery,
    sourceBinding: sourceDiscovery?.sourceBinding, original: issued.discovery ? original : null,
    output: issued.discovery ? output.slice() : null });
  return materialized;
}

function verifyUnchangedMappings(original, output, mappings) {
  for (const mapping of mappings) {
    if (mapping.kind !== 'unchanged') continue;
    const left = original.subarray(mapping.sourceOffset, mapping.sourceOffset + mapping.length);
    const right = output.subarray(mapping.outputOffset, mapping.outputOffset + mapping.length);
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  }
  return true;
}

function validatorResult(name, executed, ok, reason = null, detail = null) {
  return deepFreeze({ validator: name, executed, status: ok ? 'passed' : 'failed', reason: ok ? null : reason, detail: clone(detail) });
}

function discoveryValidatorFieldsValid(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  for (const [key, predicate] of [
    ['completeness', (value) => value === 'complete'],
    ['complete', (value) => value === true],
    ['cancelled', (value) => value === false],
    ['partial', (value) => value === false],
  ]) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(result, key); }
    catch { return false; }
    if (descriptor == null) {
      try { if (key in result) return false; }
      catch { return false; }
      continue;
    }
    if (!Object.hasOwn(descriptor, 'value') || !predicate(descriptor.value)) return false;
  }
  return true;
}

async function executeExternal(name, fn, context) {
  if (typeof fn !== 'function') return validatorResult(name, false, false, 'required-validator-unavailable');
  if (name === 'independent-differential' && context.preservationRequiresTrustedProvider && !context.independentOracleTrusted) {
    return validatorResult(name, false, false, 'independent-oracle-provider-untrusted');
  }
  try {
    const result = await fn(context);
    if (context.transaction.discovery && result && (result.ok === false
      || (result.status != null && !['passed', 'valid'].includes(String(result.status).toLowerCase()))
      || (result.completeness != null && result.completeness !== 'complete')
      || !discoveryValidatorFieldsValid(result))) {
      return validatorResult(name, true, false, result.reason || 'validator-incomplete');
    }
    if (!result || (result.ok !== true && result.status !== 'passed' && result.status !== 'valid')) return validatorResult(name, true, false, result?.reason || 'validator-rejected', result || null);
    if (name === 'independent-differential') {
      const contractFailure = independentOracleResultFailure(result, context);
      if (contractFailure) return validatorResult(name, true, false, contractFailure, result);
    }
    const identityFailure = formatIdentityMismatch(result, context.transaction, context.expectedOutputHash);
    if (identityFailure) return validatorResult(name, true, false, identityFailure, result);
    const relocationFailure = name === 'relocations' ? relocationResultFailure(result) : null;
    if (relocationFailure) return validatorResult(name, true, false, relocationFailure, result);
    return validatorResult(name, true, true, null, result);
  } catch (error) {
    return validatorResult(name, true, false, String(error?.message || error));
  }
}

export async function validateRebuildTransaction(transaction, materialized, options = {}) {
  if (!transaction || transaction.schemaVersion !== REBUILD_TRANSACTION_SCHEMA) return { status: 'invalid', reason: 'rebuild-v2-transaction-schema-invalid' };
  if (!transactionIdentityValid(transaction)) return { status: 'invalid', reason: 'rebuild-v2-transaction-identity-invalid', transactionId: transaction.transactionId || null };
  if (!materialized || materialized.status !== 'materialized' || materialized.transactionId !== transaction.transactionId) return { status: 'invalid', reason: 'rebuild-v2-materialization-invalid' };
  const issued = ISSUED_MATERIALIZATIONS.get(materialized);
  if (!issued || issued.transaction !== transaction) return { status: 'invalid', reason: 'rebuild-v2-materialization-identity-invalid' };
  let control;
  let original;
  if (options.original == null) return { status: 'invalid', reason: 'rebuild-v2-original-source-required', transactionId: transaction.transactionId };
  try {
    if (issued.discovery) {
      control = discoveryControl(options);
      original = await discoverySourceBytes(options.original, issued.discovery.sourceLength, control);
      if (!sameDiscoveryBytes(original, issued.original) || !sameDiscoveryBytes(materialized.bytes, issued.output)) {
        return { status: 'invalid', reason: 'rebuild-v2-discovery-bytes-mismatch' };
      }
    } else original = await sourceBytes(options.original);
  }
  catch (error) { if (issued.discovery) return discoveryError(error, 'invalid'); return { status: 'invalid', reason: 'rebuild-v2-original-source-unavailable', detail: String(error?.message || error), transactionId: transaction.transactionId }; }
  if (!materializationIdentityValid(transaction, materialized, original)) return { status: 'invalid', reason: 'rebuild-v2-materialization-identity-invalid', transactionId: transaction.transactionId };
  if (transaction.requireIndependentOracle === true && options.loaderReparse === options.independentOracle) {
    return { status: 'invalid', reason: 'rebuild-v2-independent-oracle-reuses-loader', transactionId: transaction.transactionId };
  }
  const validators = [];
  const builtins = new Map();
  const sourceMatches = hashBytes(original) === transaction.sourceHash;
  const structureMatches = materialized.outputLength === materialized.sourceLength + transaction.sizeDelta
    && materialized.outputHash === hashBytes(materialized.bytes)
    && materialized.outputIdentity === canonicalOutputIdentity(transaction.transactionId, materialized.outputHash);
  const unchangedMatches = verifyUnchangedMappings(original, materialized.bytes, materialized.mappings);
  const evidenceComplete = transaction.operations.every((operation) => operation.provenance && Object.keys(operation.provenance).length > 0);
  const preservationRequiresTrustedProvider = ['elf-comment', 'pe-timestamp', 'macho-min-version'].includes(transaction.expectedOriginalState?.formatSafe?.kind);
  const independentOracleTrusted = isCanonicalIndependentOracleProvider(options.independentOracle);
  builtins.set('source-precondition', () => validatorResult('source-precondition', true, sourceMatches, 'source-hash-mismatch'));
  builtins.set('structure', () => validatorResult('structure', true, structureMatches, 'output-length-inconsistent'));
  builtins.set('unchanged-regions', () => validatorResult('unchanged-regions', true, unchangedMatches, 'unchanged-region-differed'));
  builtins.set('evidence', () => validatorResult('evidence', true, evidenceComplete, 'operation-provenance-missing'));

  let discoveryProof = null;
  if (issued.discovery) {
    let result;
    try {
      const snapshotId = `rebuild-reparse:${materialized.outputIdentity}`;
      const reparsed = await awaitDiscovery(control, () => parseDiscoveryBytes(transaction, issued.output,
        materialized.outputHash, snapshotId, control, options));
      const comparison = verifyDiscoveryReparse(issued.sourceBinding, reparsed.artifact, { expectedOutputHash: materialized.outputHash });
      if (!comparison.ok) throw new Error(comparison.reason);
      // Reuse the existing bounded transformation validator. No new layout
      // equivalence engine, caller success boolean, or identity digest grants
      // permission to rewrite discovery-bearing bytes.
      if (transaction.sizeDelta !== 0 || transaction.impact.layoutMoving
        || !['elf-comment', 'pe-timestamp', 'macho-min-version'].includes(transaction.expectedOriginalState?.formatSafe?.kind)) {
        throw new Error('rebuild-v2-discovery-transform-unsupported');
      }
      const { validateFormatSafeMutation, inspectFormatSafeImage } = await import('./format-safe.js');
      if (inspectFormatSafeImage(issued.original).snapshot.signatureState !== 'unsigned') {
        throw new Error('rebuild-v2-discovery-signed-input-unsupported');
      }
      const transform = validateFormatSafeMutation({ transaction, original: issued.original, output: issued.output });
      if (transform.ok !== true) throw new Error(transform.reason || 'rebuild-v2-discovery-transform-rejected');
      checkDiscoveryControl(control);
      discoveryProof = { contract: issued.discovery, sourceArtifactId: issued.sourceBinding.artifactId,
        outputArtifactId: reparsed.artifact.artifactId, outputBinding: reparsed.artifact.binding, comparison };
      result = validatorResult(DISCOVERY_VALIDATOR, true, true, null, discoveryProof);
    } catch (error) { result = validatorResult(DISCOVERY_VALIDATOR, true, false, String(error?.message || error)); }
    builtins.set(DISCOVERY_VALIDATOR, () => result);
    if (typeof options.loaderReparse !== 'function') {
      builtins.set('loader-reparse', () => validatorResult('loader-reparse', true, result.status === 'passed', result.reason));
    }
  }

  for (const name of transaction.requiredValidators) {
    if (control) {
      try { checkDiscoveryControl(control); } catch (error) { return discoveryError(error, 'invalid'); }
    }
    if (builtins.has(name)) {
      validators.push(builtins.get(name)());
      continue;
    }
    const external = name === 'loader-reparse'
      ? options.loaderReparse
        : name === 'independent-differential'
          ? options.independentOracle
        : options.validators?.[name];
    const execute = () => executeExternal(name, external, { transaction, materialized,
      original: issued.discovery ? issued.original.slice() : original,
      output: issued.discovery ? issued.output.slice() : materialized.bytes,
      expectedOutputHash: materialized.outputHash, preservationRequiresTrustedProvider, independentOracleTrusted });
    try { validators.push(control ? await awaitDiscovery(control, execute) : await execute()); }
    catch (error) { return discoveryError(error, 'invalid'); }
  }

  if (control) {
    try {
      checkDiscoveryControl(control);
      if (!sameDiscoveryBytes(materialized.bytes, issued.output)) throw new Error('rebuild-v2-discovery-output-tampered');
    } catch (error) { return discoveryError(error, 'invalid'); }
  }
  const failures = validators.filter((item) => item.status !== 'passed');
  const allExecuted = validators.every((item) => item.executed === true);
  const independent = validators.find((item) => item.validator === 'independent-differential');
  const validation = {
    schemaVersion: REBUILD_VALIDATION_SCHEMA,
    transactionId: transaction.transactionId,
    binaryId: transaction.binaryId,
    format: transaction.format,
    architecture: transaction.architecture,
    loaderVersion: transaction.loaderVersion,
    sourceHash: transaction.sourceHash,
    outputHash: materialized.outputHash,
    outputIdentity: canonicalOutputIdentity(transaction.transactionId, materialized.outputHash),
    requiredValidators: [...transaction.requiredValidators],
    validators,
    ...(issued.discovery ? { discovery: discoveryProof } : {}),
    allRequiredExecuted: allExecuted,
    status: failures.length === 0 && allExecuted ? 'valid' : 'invalid',
    failures,
    independentDifferential: independent ? (independent.status === 'passed' ? 'executed' : 'failed') : 'unavailable',
  };
  const receipt = deepFreeze({ ...validation, validationId: `rebuild-validation:${stableDigest(validation)}` });
  if (control) {
    try { checkDiscoveryControl(control); } catch (error) { return discoveryError(error, 'invalid'); }
  }
  ISSUED_VALIDATIONS.set(receipt, { materialized, discovery: discoveryProof });
  return receipt;
}

export async function publishRebuildTransaction(materialized, validation, options = {}) {
  if (!materialized || materialized.status !== 'materialized') return { status: 'rejected', reason: 'rebuild-v2-materialization-not-complete' };
  if (!validation || validation.schemaVersion !== REBUILD_VALIDATION_SCHEMA || validation.status !== 'valid' || validation.allRequiredExecuted !== true) return { status: 'rejected', reason: 'rebuild-v2-validation-not-green' };
  if (validation.transactionId !== materialized.transactionId) return { status: 'rejected', reason: 'rebuild-v2-validation-transaction-mismatch' };
  if (!validationIdentityValid(validation)) return { status: 'rejected', reason: 'rebuild-v2-validation-not-green' };
  if (!rebuildIdentityMatches(validation, materialized)) return { status: 'rejected', reason: 'rebuild-v2-validation-identity-mismatch' };
  if (validation.outputHash !== materialized.outputHash) return { status: 'rejected', reason: 'rebuild-v2-validation-output-mismatch' };
  if (validation.outputIdentity !== materialized.outputIdentity) return { status: 'rejected', reason: 'rebuild-v2-validation-output-identity-mismatch' };
  if (JSON.stringify(validation.requiredValidators) !== JSON.stringify(materialized.requiredValidators)) return { status: 'rejected', reason: 'rebuild-v2-validation-validator-set-mismatch' };
  const issued = ISSUED_MATERIALIZATIONS.get(materialized);
  const proof = ISSUED_VALIDATIONS.get(validation);
  if (!issued || proof?.materialized !== materialized) return { status: 'rejected', reason: 'rebuild-v2-validation-unissued-or-stale' };
  let control;
  if (issued.discovery) {
    try {
      control = discoveryControl(options);
      checkDiscoveryControl(control);
      if (!proof.discovery || !sameDiscoveryBytes(materialized.bytes, issued.output)) throw new Error('rebuild-v2-discovery-output-tampered');
    } catch (error) { return discoveryError(error); }
    if (typeof options.readCommitted !== 'function') return { status: 'not-published', reason: 'rebuild-v2-discovery-readback-required' };
  }
  try {
    if (hashBytes(materialized.bytes) !== materialized.outputHash) return { status: 'rejected', reason: 'rebuild-v2-materialization-output-tampered' };
  } catch (error) {
    return { status: 'rejected', reason: 'rebuild-v2-materialization-output-invalid', detail: String(error?.message || error) };
  }
  if (typeof options.atomicPromote !== 'function') return { status: 'not-published', reason: 'rebuild-v2-atomic-promotion-required', outputHash: materialized.outputHash };
  try {
    // The promoter receives a detached copy. A publication adapter must not be
    // able to mutate the validated temporary output after its identity is fixed.
    const promote = () => options.atomicPromote(issued.discovery ? issued.output.slice() : materialized.bytes.slice(), { materialized, validation });
    const result = control ? await awaitDiscovery(control, promote) : await promote();
    if (!result || result.atomic !== true || result.committed !== true) return { status: 'rejected', reason: 'rebuild-v2-publication-not-atomic' };
    const protocol = String(result.protocol || '');
    if (!ATOMIC_PUBLICATION_PROTOCOLS.has(protocol)) return { status: 'rejected', reason: 'rebuild-v2-publication-protocol-invalid' };
    const publicationIdentity = String(result.publicationIdentity || '').trim();
    if (!publicationIdentity) return { status: 'rejected', reason: 'rebuild-v2-publication-identity-required' };
    if (result.transactionId == null || result.outputHash == null || result.outputIdentity == null) return { status: 'rejected', reason: 'rebuild-v2-publication-identity-incomplete' };
    if (String(result.transactionId) !== materialized.transactionId) return { status: 'rejected', reason: 'rebuild-v2-publication-transaction-mismatch' };
    if (String(result.outputHash) !== materialized.outputHash) return { status: 'rejected', reason: 'rebuild-v2-publication-output-mismatch' };
    const outputIdentity = canonicalOutputIdentity(materialized.transactionId, materialized.outputHash);
    if (String(result.outputIdentity) !== outputIdentity) return { status: 'rejected', reason: 'rebuild-v2-publication-output-identity-mismatch' };
    for (const field of ['binaryId', 'format', 'architecture', 'loaderVersion', 'sourceHash']) {
      if (result[field] != null) {
        const expected = materialized[field];
        const observed = String(result[field]);
        if ((field === 'sourceHash' ? observed.toLowerCase() : observed) !== (field === 'sourceHash' ? String(expected).toLowerCase() : String(expected))) {
          return { status: 'rejected', reason: 'rebuild-v2-publication-identity-mismatch' };
        }
      }
    }
    let readback = null;
    if (issued.discovery) {
      const request = Object.freeze({ publicationIdentity, transactionId: materialized.transactionId,
        outputHash: materialized.outputHash, outputIdentity, expectedLength: issued.output.length,
        maxBytes: REBUILD_DISCOVERY_MAX_BYTES, signal: control.signal, deadline: control.deadline });
      // readCommitted opens the committed object as a ByteSource-compatible
      // { size, read(offset, length, options) }. Stat precedes read; even a lying
      // size is caught by bounding the returned bytes before copying/hashing.
      const committed = await awaitDiscovery(control, () => options.readCommitted(request));
      discoveryLength(committed?.size, request.expectedLength);
      if (typeof committed?.read !== 'function') throw new Error('rebuild-v2-discovery-readback-unreadable');
      const raw = await awaitDiscovery(control, () => committed.read(0n, request.expectedLength, request));
      discoveryLength(committed.size, request.expectedLength);
      const bytes = discoveryByteView(raw, request.expectedLength).slice();
      if (!sameDiscoveryBytes(bytes, issued.output)) throw new Error('rebuild-v2-discovery-committed-bytes-mismatch');
      checkDiscoveryControl(control);
      readback = { verified: true, byteLength: bytes.length, outputHash: materialized.outputHash,
        sourceArtifactId: proof.discovery.sourceArtifactId, outputArtifactId: proof.discovery.outputArtifactId };
    }
    const identity = { atomic: true, committed: true, protocol, transactionId: materialized.transactionId,
      outputHash: materialized.outputHash, outputIdentity, publicationIdentity };
    return deepFreeze({ status: 'published', ...identity,
      ...(readback ? { discovery: readback } : {}), result: readback ? identity : clone(result) });
  } catch (error) {
    if (issued.discovery) return { ...discoveryError(error), commitState: 'unverified' };
    return { status: 'rejected', reason: 'rebuild-v2-publication-failed', detail: String(error?.message || error) };
  }
}

export function rebuildProfileSupport({ transaction, validation, publication, proof = {}, profileProof = null, expectedCommitSha = null, expectedTreeSha = null } = {}) {
  const requiredCount = transaction?.requiredValidators?.length || 0;
  const executedCount = validation?.validators?.filter((item) => item.executed === true && item.status === 'passed').length || 0;
  const f6Denominator = evaluateF6RebuildDenominator({ transaction, validation, publication, proof });
  const expectedProfiles = FORMAT_PROFILES[transaction?.format] || [];
  const itemId = transaction?.format ? `S2-F6-${String(transaction.format).toUpperCase()}` : null;
  const formatCoverageComplete = itemId != null && isValidatedStage2CapabilityProof(profileProof, { itemId, profileIds: expectedProfiles });
  const formatProfileIds = formatCoverageComplete ? sorted(profileProof.profileIds) : [];
  const expectedCommit = String(expectedCommitSha || '').toLowerCase();
  const expectedTree = String(expectedTreeSha || '').toLowerCase();
  const exactCandidateIdentity = /^[0-9a-f]{40}$/.test(expectedCommit)
    && /^[0-9a-f]{40}$/.test(expectedTree)
    && profileProof?.commitSha === expectedCommit
    && profileProof?.treeSha === expectedTree;
  const outputIdentity = transaction?.transactionId && validation?.outputHash
    ? canonicalOutputIdentity(transaction.transactionId, validation.outputHash)
    : null;
  const exact = transaction?.schemaVersion === REBUILD_TRANSACTION_SCHEMA
    && transactionIdentityValid(transaction)
    && validation?.schemaVersion === REBUILD_VALIDATION_SCHEMA
    && validationIdentityValid(validation)
    && validation.status === 'valid'
    && validation.allRequiredExecuted === true
    && executedCount === requiredCount
    && validation.transactionId === transaction.transactionId
    && rebuildIdentityMatches(validation, transaction)
    && validation.sourceHash === transaction.sourceHash
    && JSON.stringify(validation.requiredValidators) === JSON.stringify(transaction.requiredValidators)
    && validation.outputIdentity === outputIdentity
    && publication?.status === 'published'
    && publication.atomic === true
    && publication.committed === true
    && publication.transactionId === transaction.transactionId
    && publication.outputHash === validation.outputHash
    && publication.outputIdentity === outputIdentity
    && ATOMIC_PUBLICATION_PROTOCOLS.has(publication.protocol)
    && !!publication.publicationIdentity
    && transaction.requiredValidators.includes('loader-reparse')
    && transaction.requiredValidators.includes('independent-differential')
    && proof.exactHead === true
    && proof.negativeValidatorTest === true
    && proof.staleIdentityTest === true
    && proof.formatSpecificValidatorTests === true
    && proof.atomicInterruptionTest === true
    && proof.realFixture === true
    && f6Denominator.status === 'closed'
    && formatCoverageComplete
    && exactCandidateIdentity;
  const result = deepFreeze({
    format: transaction?.format || null,
    architecture: transaction?.architecture || null,
    operationClass: transaction?.sizeDelta === 0 ? 'same-size' : transaction?.sizeDelta > 0 ? 'growth' : 'shrink',
    requiredValidatorCount: requiredCount,
    executedValidatorCount: executedCount,
    formatProfileIds,
    formatCoverageComplete,
    f6Denominator,
    outputIdentity,
    status: exact ? 'supported-for-exact-rebuild-profile' : 'unsupported',
    authority: exact ? 'L4-validated-atomic-publication' : 'L3-plan-only',
  });
  if (exact) VALID_REBUILD_PROFILE_SUPPORT.add(result);
  return result;
}

export function isValidatedRebuildProfileSupport(value) {
  return !!value && VALID_REBUILD_PROFILE_SUPPORT.has(value) && value.status === 'supported-for-exact-rebuild-profile';
}
