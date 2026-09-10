import { stableDigest, stableStringify, deepFreeze } from '../core/identity/index.js';
import { importKnowledgePack } from '../signature/index.js';
import { createArtifactDescriptor } from '../core/artifacts/contracts.js';
import { createResourceBudget } from './resource-budget.js';

export const PACKAGE_ENVELOPE_VERSION = 'hex-phase12-package-envelope-v1';
export const PACKAGE_SCHEMA_VERSION = 1;
export const PHASE12_PROVIDER_OUTPUT_SCHEMA = 'provider-v1';
export const MAX_PACKAGE_INPUT_BYTES = 32 * 1024 * 1024;
export const DEFAULT_PACKAGE_LIMITS = Object.freeze({ maxDepth: 64, maxStrings: 200_000, maxStringBytes: 4 * 1024 * 1024, maxTokens: 2_000_000, maxEntries: 1_000_000 });

export class PackageValidationError extends Error {
  constructor(code, message = code, detail = null) { super(message); this.name = 'PackageValidationError'; this.code = code; this.detail = detail; }
}

function required(value, code) {
  if (typeof value !== 'string') throw new PackageValidationError(code);
  const text = value.trim();
  if (!text) throw new PackageValidationError(code);
  return text;
}

function positiveLimit(value, fallback, name, code = 'package-resource-limit-invalid') {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new PackageValidationError(code, `${name} must be a positive safe integer`, { name, value });
  }
  return n;
}

function normalizedPackageLimits(options = {}) {
  return Object.freeze({
    maxDepth: positiveLimit(options.maxDepth, DEFAULT_PACKAGE_LIMITS.maxDepth, 'maxDepth'),
    maxStrings: positiveLimit(options.maxStrings, DEFAULT_PACKAGE_LIMITS.maxStrings, 'maxStrings'),
    maxStringBytes: positiveLimit(options.maxStringBytes, DEFAULT_PACKAGE_LIMITS.maxStringBytes, 'maxStringBytes'),
    maxTokens: positiveLimit(options.maxTokens, DEFAULT_PACKAGE_LIMITS.maxTokens, 'maxTokens'),
    maxEntries: positiveLimit(options.maxEntries, DEFAULT_PACKAGE_LIMITS.maxEntries, 'maxEntries'),
  });
}

function bytesOf(value) {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new PackageValidationError('package-input-type-invalid');
}

function utf8ByteLength(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; ) {
    const codePoint = text.codePointAt(i);
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    i += codePoint > 0xffff ? 2 : 1;
  }
  return bytes;
}

// Iterative (no recursion) shape traversal so the depth/entry/string budgets
// and cycle rejection are the FIRST resource guards on the object path (#5219).
// The bounded string/bytes path enforces depth/string/token budgets through
// scanJsonBudget before JSON.parse; the object path previously canonicalized
// through stableStringify first, so a hostile deep or cyclic graph reached the
// core canonicalizer's recursion (and the JS stack) before any budget applied.
//
// The traversal is also a SINGLE-ADMISSION snapshot: every authority-bearing
// property/element is read exactly once from the caller graph and its admitted
// value is copied into a fresh plain snapshot (plain objects/arrays/Maps/Sets;
// Dates are admitted as their ISO string; binary views stay leaves — their
// byteLength is fixed, so the per-byte charge cannot be mutated past).
// Canonicalization consumes the snapshot, so a stateful getter/exotic iterable
// cannot present a bounded value to the preflight and an unbounded value to
// stableStringify. jsonSafe parity is preserved: per-path ancestry (a node is
// an ancestor only while its own subtree is on the walk, so shared-but-acyclic
// references stay valid); object keys whose jsonSafe value would be null
// (undefined/function/symbol/non-finite) are omitted from the snapshot exactly
// as jsonSafe omits them from canonical output, while array/Set/Map slots keep
// them (jsonSafe re-normalizes to null in place). Binary views expand to one
// canonical array entry per byte through jsonSafe's Array.from, so each view
// leaf charges its byteLength against the entry budget. The scan also carries
// a conservative canonical-byte lower bound (≥2 bytes per entry, ≥ UTF-8
// length + 2 per string, ≥2 per expanded binary byte) checked against maxBytes
// so a stricter byte limit rejects before any canonicalization work. Token
// counts have no object analogue and stay byte-budget covered. Returns the
// admitted snapshot.
function scanObjectBudget(value, limits, maxBytes) {
  const { maxDepth, maxStrings, maxStringBytes, maxEntries } = limits;
  let strings = 0;
  let stringBytes = 0;
  let entries = 0;
  let canonicalBytes = 0;
  const ancestors = new Set();
  const chargeCanonicalBytes = (minimum) => {
    canonicalBytes += minimum;
    if (canonicalBytes > maxBytes) {
      throw new PackageValidationError('package-input-too-large', `package object exceeds maximum size of ${maxBytes} bytes`);
    }
  };
  const countString = (text) => {
    strings += 1;
    const bytes = utf8ByteLength(text);
    stringBytes += bytes;
    if (strings > maxStrings || stringBytes > maxStringBytes) {
      throw new PackageValidationError('package-string-budget-exceeded');
    }
    chargeCanonicalBytes(bytes + 2);
  };
  const chargeEntry = () => {
    entries += 1;
    if (entries > maxEntries) throw new PackageValidationError('package-entry-budget-exceeded');
    chargeCanonicalBytes(2);
  };
  // Mirrors jsonSafe's own-property assignment discipline: inherited names
  // (including __proto__, setters and non-writable prototype properties) are
  // written with defineProperty so no inherited setter can run on the snapshot.
  const defineKey = (target, key, val) => {
    if (key in target) Object.defineProperty(target, key, { value: val, enumerable: true, configurable: true, writable: true });
    else target[key] = val;
  };
  // Values jsonSafe canonicalizes to null: omitted from plain objects (unless
  // the raw value itself is null), kept in place inside arrays/Sets/Maps.
  const jsonSafeNull = (item) => item === undefined || typeof item === 'function' || typeof item === 'symbol' || (typeof item === 'number' && !Number.isFinite(item));
  const enter = (container, depth) => {
    if (ancestors.has(container)) {
      throw new PackageValidationError('package-input-structure-invalid', 'package input contains a cyclic reference');
    }
    if (depth > maxDepth) throw new PackageValidationError('package-nesting-budget-exceeded');
    ancestors.add(container);
    if (container instanceof Map) return { container, depth, kind: 'map', iterator: container.entries(), stage: 'next', entry: null, admittedKey: undefined, snap: new Map() };
    if (container instanceof Set) return { container, depth, kind: 'set', iterator: container.values(), snap: new Set() };
    if (Array.isArray(container)) return { container, depth, kind: 'array', index: 0, snap: [] };
    return { container, depth, kind: 'object', keys: Object.keys(container), index: 0, snap: {} };
  };
  const rootFrame = enter(value, 1);
  rootFrame.parentSlot = null;
  const stack = [rootFrame];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    let item;
    let slot;
    if (frame.kind === 'map') {
      // Map key/value are descended sequentially (the key subtree is fully
      // processed before the value is entered) so ancestry stays path-local:
      // a shared reference between a Map key and its value is not a cycle.
      if (frame.stage === 'next') {
        const step = frame.iterator.next();
        if (step.done) {
          ancestors.delete(frame.container);
          stack.pop();
          if (frame.parentSlot) assignSlot(frame.parentSlot, frame.snap);
          continue;
        }
        chargeEntry();
        frame.entry = step.value;
        frame.stage = 'key';
        descend(frame.entry[0], frame.depth, { mapFrame: frame, part: 'key' });
        continue;
      }
      if (frame.stage === 'key') {
        frame.stage = 'value';
        descend(frame.entry[1], frame.depth, { mapFrame: frame, part: 'value' });
        continue;
      }
      frame.stage = 'next';
      continue;
    } else if (frame.kind === 'set') {
      const step = frame.iterator.next();
      if (step.done) {
        ancestors.delete(frame.container);
        stack.pop();
        if (frame.parentSlot) assignSlot(frame.parentSlot, frame.snap);
        continue;
      }
      chargeEntry();
      item = step.value;
      slot = { setFrame: frame };
    } else if (frame.kind === 'array') {
      if (frame.index >= frame.container.length) {
        ancestors.delete(frame.container);
        stack.pop();
        if (frame.parentSlot) assignSlot(frame.parentSlot, frame.snap);
        continue;
      }
      chargeEntry();
      const index = frame.index++;
      item = frame.container[index];
      slot = { arrayFrame: frame, arrayIndex: index };
    } else {
      if (frame.index >= frame.keys.length) {
        ancestors.delete(frame.container);
        stack.pop();
        if (frame.parentSlot) assignSlot(frame.parentSlot, frame.snap);
        continue;
      }
      const key = frame.keys[frame.index++];
      item = frame.container[key];
      // jsonSafe omits plain-object entries whose canonical value is null
      // (unless the raw value itself is null): they contribute no canonical
      // bytes and no entry.
      if (jsonSafeNull(item) && item !== null) continue;
      chargeEntry();
      countString(key);
      slot = { objectFrame: frame, objectKey: key };
    }
    descend(item, frame.depth, slot);
  }
  function assignSlot(target, admitted) {
    if (target.mapFrame) {
      if (target.part === 'key') target.mapFrame.admittedKey = admitted;
      else target.mapFrame.snap.set(target.mapFrame.admittedKey, admitted);
    } else if (target.setFrame) target.setFrame.snap.add(admitted);
    else if (target.arrayFrame) target.arrayFrame.snap[target.arrayIndex] = admitted;
    else defineKey(target.objectFrame.snap, target.objectKey, admitted);
  }
  function descend(item, parentDepth, slot) {
    if (item === null || typeof item !== 'object') {
      if (typeof item === 'string') countString(item);
      else if (typeof item === 'bigint') countString(item.toString());
      if (slot) assignSlot(slot, item);
      return;
    }
    if (item instanceof Date) {
      // jsonSafe canonicalizes a Date to its ISO string; admit that string
      // once so no downstream pass can observe a different value (#5219).
      if (!Number.isFinite(item.getTime())) {
        throw new PackageValidationError('package-input-structure-invalid', 'package input contains an invalid date');
      }
      const iso = item.toISOString();
      countString(iso);
      if (slot) assignSlot(slot, iso);
      return;
    }
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) {
      entries += item.byteLength;
      if (entries > maxEntries) throw new PackageValidationError('package-entry-budget-exceeded');
      chargeCanonicalBytes(2 * item.byteLength);
      if (slot) assignSlot(slot, item);
      return;
    }
    const frame = enter(item, parentDepth + 1);
    frame.parentSlot = slot;
    stack.push(frame);
  }
  return rootFrame.snap;
}

function scanJsonBudget(bytes, limits = {}) {
  const normalized = normalizedPackageLimits(limits);
  const { maxDepth, maxStrings, maxStringBytes, maxTokens } = normalized;
  let depth = 0, strings = 0, stringBytes = 0, tokens = 0, inString = false, escaped = false, currentStringBytes = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    tokens++;
    if (tokens > maxTokens) throw new PackageValidationError('package-token-budget-exceeded');
    if (inString) {
      if (escaped) { escaped = false; currentStringBytes++; continue; }
      if (byte === 92) { escaped = true; continue; }
      if (byte === 34) {
        inString = false; strings++; stringBytes += currentStringBytes; currentStringBytes = 0;
        if (strings > maxStrings || stringBytes > maxStringBytes) throw new PackageValidationError('package-string-budget-exceeded');
      } else currentStringBytes++;
      continue;
    }
    if (byte === 34) { inString = true; currentStringBytes = 0; continue; }
    if (byte === 123 || byte === 91) { depth++; if (depth > maxDepth) throw new PackageValidationError('package-nesting-budget-exceeded'); }
    else if (byte === 125 || byte === 93) depth--;
    if (depth < 0) throw new PackageValidationError('package-json-structure-invalid');
  }
  if (inString || depth !== 0) throw new PackageValidationError('package-json-structure-invalid');
  return Object.freeze({ bytes: bytes.byteLength, depth: maxDepth, strings, stringBytes, tokens });
}

function countEntries(value, limits, depth = 0, state = { entries: 0 }) {
  if (!value || typeof value !== 'object') return state;
  if (depth > limits.maxDepth) throw new PackageValidationError('package-nesting-budget-exceeded');
  if (Array.isArray(value)) {
    state.entries += value.length;
    for (const item of value) countEntries(item, limits, depth + 1, state);
  } else {
    const keys = Object.keys(value);
    state.entries += keys.length;
    for (const key of keys) countEntries(value[key], limits, depth + 1, state);
  }
  if (state.entries > limits.maxEntries) throw new PackageValidationError('package-entry-budget-exceeded');
  return state;
}

export function parseBoundedPackageInput(value, options = {}) {
  const bytes = bytesOf(value);
  const maxBytes = positiveLimit(options.maxBytes, MAX_PACKAGE_INPUT_BYTES, 'maxBytes');
  if (bytes.byteLength > maxBytes) throw new PackageValidationError('package-input-too-large', 'package input exceeds pre-parse byte budget');
  scanJsonBudget(bytes, options);
  let parsed;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
  catch (error) { throw new PackageValidationError('package-json-malformed', error.message); }
  const limits = normalizedPackageLimits(options);
  countEntries(parsed, limits);
  return Object.freeze({ value: parsed, inputBytes: bytes.byteLength, scan: scanJsonBudget(bytes, options) });
}

function packageKey(input) {
  return {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    kind: input.kind,
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    requiredHexApi: input.requiredHexApi || null,
    requiredSemanticVersions: input.requiredSemanticVersions || null,
    supportedTargets: input.supportedTargets || null,
    dependencies: input.dependencies || [],
    payload: input.payload,
  };
}

function normalizeDependencies(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new PackageValidationError('package-dependencies-invalid');
  return value.map((dependency) => {
    if (!dependency || typeof dependency !== 'object') throw new PackageValidationError('package-dependency-invalid');
    const id = required(dependency.packageId ?? dependency.id, 'package-dependency-id-required');
    const contentHash = required(dependency.contentHash, 'package-dependency-content-identity-required');
    if (!/^[a-z0-9:_-]{4,256}$/i.test(contentHash)) throw new PackageValidationError('package-dependency-content-identity-invalid');
    return { packageId: id, contentHash, packageVersion: required(dependency.packageVersion ?? dependency.version, 'package-dependency-version-required') };
  }).sort((a, b) => a.packageId.localeCompare(b.packageId) || a.contentHash.localeCompare(b.contentHash));
}

export function packageContentIdentity(input) { return stableDigest(packageKey(input)); }

export function createPackageEnvelope(input = {}) {
  const kind = required(input.kind, 'package-kind-required');
  const packageId = required(input.packageId ?? `${kind}-local`, 'package-id-required');
  const packageVersion = required(input.packageVersion ?? input.version ?? '1', 'package-version-required');
  if (input.payload === undefined) throw new PackageValidationError('package-payload-required');
  const dependencies = normalizeDependencies(input.dependencies);
  // The producer side always carries a provenance record. A structured value
  // that cannot stand in for a record (array / primitive) fails closed here so
  // an envelope that would fail its own import contract is never minted.
  const provenance = input.provenance == null
    ? { source: 'local' }
    : validatedProvenanceRecord(input.provenance);
  const envelope = {
    format: PACKAGE_ENVELOPE_VERSION,
    manifestVersion: PACKAGE_SCHEMA_VERSION,
    packageId,
    packageVersion,
    kind,
    provenance,
    license: String(input.license || 'unspecified'),
    requiredHexApi: input.requiredHexApi || null,
    requiredSemanticVersions: input.requiredSemanticVersions || null,
    supportedTargets: input.supportedTargets || null,
    dependencies,
    payloadIndex: input.payloadIndex || null,
    payload: input.payload,
  };
  // Provenance integrity binding (#5637): the content identity deliberately
  // excludes provenance (semantic package content vs. trust metadata), so the
  // provenance record gets its own digest. Import verifies this digest before
  // trusting the envelope, making silent provenance erasure or substitution
  // detectable without changing the package content identity contract.
  envelope.provenanceHash = stableDigest(stableStringify(provenance));
  envelope.contentHash = packageContentIdentity(envelope);
  return deepFreeze(envelope);
}

function validatedProvenanceRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PackageValidationError('package-provenance-required', 'a provenance record object is required');
  }
  return value;
}

function validateEnvelopeShape(envelope, options = {}) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new PackageValidationError('package-envelope-invalid');
  if (envelope.format !== PACKAGE_ENVELOPE_VERSION) throw new PackageValidationError('package-envelope-format-invalid');
  if (envelope.manifestVersion !== PACKAGE_SCHEMA_VERSION) throw new PackageValidationError('package-envelope-version-unsupported');
  required(envelope.packageId, 'package-id-required');
  required(envelope.packageVersion, 'package-version-required');
  required(envelope.kind, 'package-kind-required');
  required(envelope.contentHash, 'package-content-identity-required');
  if (envelope.payload === undefined) throw new PackageValidationError('package-payload-required');
  // The import boundary enforces the same provenance contract the producer
  // side guarantees (#5637): a provenance record must exist and must match
  // its own integrity binding, so erasing or swapping provenance under an
  // unchanged contentHash is no longer accepted.
  validatedProvenanceRecord(envelope.provenance === undefined ? null : envelope.provenance);
  if (typeof envelope.provenanceHash !== 'string' || !envelope.provenanceHash) {
    throw new PackageValidationError('package-provenance-binding-required');
  }
  const expectedProvenanceHash = stableDigest(stableStringify(envelope.provenance));
  if (expectedProvenanceHash !== envelope.provenanceHash) {
    throw new PackageValidationError('package-provenance-identity-mismatch', 'package provenance does not match its integrity binding');
  }
  countEntries(envelope.payload, normalizedPackageLimits(options));
  const dependencies = normalizeDependencies(envelope.dependencies);
  const expected = packageContentIdentity({ ...envelope, dependencies });
  if (expected !== envelope.contentHash) throw new PackageValidationError('package-content-identity-mismatch', 'package content identity does not match canonical payload');
  return deepFreeze({ ...envelope, dependencies });
}

export function validatePackageEnvelope(envelope, options = {}) {
  try { return { ok: true, value: validateEnvelopeShape(envelope, options) }; }
  catch (error) { return { ok: false, error: error.message, code: error.code, detail: error.detail || null }; }
}

export function importPhase12Package(value, options = {}) {
  let parsed;
  if (typeof value === 'object' && value !== null && !(value instanceof Uint8Array) && !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) {
    // Bounded shape traversal FIRST (#5219): depth/entry/string budgets, cycle
    // rejection and a conservative maxBytes lower bound apply before any
    // canonicalization work. The traversal admits each caller property exactly
    // once into a plain snapshot, and everything downstream (stringify, byte
    // check, envelope validation) consumes that snapshot — a stateful getter
    // or exotic iterable cannot present a bounded value to the preflight and
    // an unbounded value to canonicalization. The exact byte check below stays
    // authoritative; the preflight bound is never weaker than maxBytes.
    const maxBytes = positiveLimit(options.maxBytes, MAX_PACKAGE_INPUT_BYTES, 'maxBytes', 'package-envelope-resource-limit-invalid');
    const admitted = scanObjectBudget(value, normalizedPackageLimits(options), maxBytes);
    const encoded = stableStringify(admitted);
    if (new TextEncoder().encode(encoded).byteLength > maxBytes) {
      throw new PackageValidationError('package-input-too-large', `package object exceeds maximum size of ${maxBytes} bytes`);
    }
    parsed = { value: admitted };
    if (new TextEncoder().encode(encoded).byteLength > maxBytes) {
      throw new PackageValidationError('package-input-too-large', `package object exceeds maximum size of ${maxBytes} bytes`);
    }
    parsed = { value };
  } else {
    parsed = parseBoundedPackageInput(value, options);
  }
  const input = parsed.value;
  if (input?.format === 'hex-knowledge-pack') {
    const legacy = importKnowledgePack(input);
    if (!legacy.ok) throw new PackageValidationError('legacy-knowledge-pack-invalid', legacy.error);
    return createPackageEnvelope({
      kind: 'knowledge', packageId: input.packageId || `legacy-knowledge-${stableDigest(input)}`,
      packageVersion: `v${input.version}`, payload: legacy.pack,
      provenance: input.provenance, license: input.license,
      requiredSemanticVersions: { knowledge: '3', signature: String(input.version) },
      payloadIndex: { signatures: legacy.pack.signatures.length, mappings: legacy.pack.mappings.length },
    });
  }
  const checked = validateEnvelopeShape(input, options);
  return checked;
}

export function resolvePackageDependencies(envelope, dependencies = []) {
  const checked = validateEnvelopeShape(envelope);
  const available = new Map((dependencies || []).map((item) => [item.packageId, item]));
  const resolved = [];
  for (const dependency of checked.dependencies) {
    const found = available.get(dependency.packageId);
    if (!found || found.contentHash !== dependency.contentHash || String(found.packageVersion) !== dependency.packageVersion) {
      throw new PackageValidationError('package-dependency-not-pinned', `dependency ${dependency.packageId} is not resolved to its exact identity`);
    }
    resolved.push(Object.freeze({ packageId: dependency.packageId, contentHash: dependency.contentHash, packageVersion: dependency.packageVersion }));
  }
  return Object.freeze(resolved);
}

export function createPackageArtifactDescriptor(envelope, input = {}) {
  const checked = validateEnvelopeShape(envelope);
  return createArtifactDescriptor({
    binaryId: required(input.binaryId, 'package-artifact-binary-id-required'),
    entityId: input.entityId || null,
    artifactKind: required(input.artifactKind || `phase12.package.${checked.kind}`, 'package-artifact-kind-required'),
    producerId: `package:${checked.packageId}`,
    producerVersion: checked.packageVersion,
    versions: { loader: input.loaderVersion || 'n/a', architectureSemantic: input.architectureSemanticVersion || 'n/a', abiSemantic: input.abiSemanticVersion || 'n/a', semanticSchema: input.semanticSchemaVersion || 'n/a' },
    relevance: { loader: input.loaderVersion != null, architectureSemantic: input.architectureSemanticVersion != null, abiSemantic: input.abiSemanticVersion != null, semanticSchema: input.semanticSchemaVersion != null },
    providerVersion: checked.packageVersion,
    config: input.options || {},
    keyExtras: { packageContentHash: checked.contentHash, packageId: checked.packageId, packageKind: checked.kind },
    upstreamArtifactIds: input.upstreamArtifactIds || [],
    originRefs: input.originRefs || [],
  });
}

const ALLOWED_OUTPUT_FIELDS = new Set(['schemaVersion', 'provenance', 'completeness', 'targetIdentity', 'items', 'results', 'unique']);
const ALLOWED_ITEM_FIELDS = new Set(['id', 'targetIdentity', 'value', 'confidence', 'metadata', 'evidence', 'provenance']);

export function validateProviderOutput(value, options = {}) {
  try {
    const maxEntries = positiveLimit(options.maxEntries, 100_000, 'maxEntries', 'provider-output-resource-limit-invalid');
    const maxBytes = positiveLimit(options.maxBytes, 8 * 1024 * 1024, 'maxBytes', 'provider-output-resource-limit-invalid');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PackageValidationError('provider-output-schema-invalid');
    for (const key of Object.keys(value)) {
      if (!ALLOWED_OUTPUT_FIELDS.has(key)) throw new PackageValidationError('provider-output-unknown-field', `unknown field: ${key}`);
    }
    const encoded = stableStringify(value);
    if (new TextEncoder().encode(encoded).byteLength > maxBytes) throw new PackageValidationError('provider-output-too-large');
    const hasItems = Object.hasOwn(value, 'items');
    const hasResults = Object.hasOwn(value, 'results');
    if (hasItems && !Array.isArray(value.items)) throw new PackageValidationError('provider-output-schema-invalid', 'items must be an array when supplied');
    if (hasResults && !Array.isArray(value.results)) throw new PackageValidationError('provider-output-schema-invalid', 'results must be an array when supplied');
    if (hasItems && hasResults) throw new PackageValidationError('provider-output-entry-collection-ambiguous');
    const entries = hasItems ? value.items : hasResults ? value.results : [];
    if (entries.length > maxEntries) throw new PackageValidationError('provider-output-entry-budget-exceeded');
    if (value.schemaVersion !== PHASE12_PROVIDER_OUTPUT_SCHEMA) throw new PackageValidationError('provider-output-schema-unsupported');
    if (!value.provenance || typeof value.provenance !== 'object' || Array.isArray(value.provenance)) throw new PackageValidationError('provider-output-provenance-required');
    if (!['complete', 'partial', 'truncated'].includes(value.completeness)) throw new PackageValidationError('provider-output-completeness-invalid');
    if (value.completeness !== 'complete' && value.unique === true) throw new PackageValidationError('provider-output-incomplete-unique-invalid');
    for (const item of entries) {
      if (!item || typeof item !== 'object') throw new PackageValidationError('provider-output-item-invalid');
      for (const key of Object.keys(item)) {
        if (!ALLOWED_ITEM_FIELDS.has(key)) throw new PackageValidationError('provider-output-item-unknown-field', `unknown item field: ${key}`);
      }
      if (typeof item.id !== 'string' || item.id.trim() === '' || item.targetIdentity == null) throw new PackageValidationError('provider-output-item-identity-required');
      if (value.targetIdentity != null && item.targetIdentity !== value.targetIdentity) throw new PackageValidationError('provider-output-item-target-mismatch');
    }
    if (options.targetIdentity != null && value.targetIdentity !== options.targetIdentity) throw new PackageValidationError('provider-output-target-mismatch');
    return { ok: true, value: deepFreeze(value) };
  } catch (error) { return { ok: false, error: error.message, code: error.code }; }
}

export function createPackageBudget(options = {}) { return createResourceBudget({ maxBytes: options.maxBytes || MAX_PACKAGE_INPUT_BYTES, maxEntries: options.maxEntries || DEFAULT_PACKAGE_LIMITS.maxEntries, ...options }); }
