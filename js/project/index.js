import { artifactIndexFromProject, isArtifactRef } from './artifact-index.js';
import {
  MAX_COMMENT_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PATCH_ENTRIES,
  MAX_PROJECT_BYTES,
  MAX_TYPE_LENGTH,
  MAX_VAR_KEY_LENGTH,
} from './limits.js';
import {
  migrateHexProject,
  ProjectMigrationError,
  PROJECT_MIGRATIONS,
} from './migrations.js';

export {
  MAX_COMMENT_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PATCH_ENTRIES,
  MAX_PROJECT_BYTES,
  MAX_TYPE_LENGTH,
  MAX_VAR_KEY_LENGTH,
};

export const HEX_PROJECT_VERSION = 2;
export const HEX_PROJECT_MIME = 'application/vnd.hex.project+json';
const MAX_COLLECTION_ITEMS = 1_000_000;
const MAX_LEGACY_CACHE_REFERENCE_LENGTH = 512;

export class ProjectFormatError extends Error {
  constructor(message, code = 'HEX_PROJECT_INVALID') {
    super(message);
    this.name = 'ProjectFormatError';
    this.code = code;
  }
}

const list = (value, name) => {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new ProjectFormatError(`${name} must be an array`);
  if (value.length > MAX_COLLECTION_ITEMS) throw new ProjectFormatError(`${name} is unreasonably large`);
  return [...value];
};

const UTF8_COUNT_CHUNK_UNITS = 8 * 1024;
const UTF8_COUNT_CHUNK_BYTES = (UTF8_COUNT_CHUNK_UNITS * 3) + 3;

function encodedByteLength(text) {
  if (text.length > MAX_PROJECT_BYTES) return text.length;
  const encoder = new TextEncoder();
  const scratch = new Uint8Array(UTF8_COUNT_CHUNK_BYTES);
  let bytes = 0;
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + UTF8_COUNT_CHUNK_UNITS, text.length);
    if (end < text.length) {
      const lead = text.charCodeAt(end - 1);
      if (lead >= 0xd800 && lead <= 0xdbff) end -= 1;
    }
    let cursor = offset;
    while (cursor < end) {
      const chunk = text.slice(cursor, end);
      const { read, written } = encoder.encodeInto(chunk, scratch);
      if (read === 0) throw new ProjectFormatError('project text cannot be measured as UTF-8', 'HEX_PROJECT_INVALID_UTF8');
      bytes += written;
      if (bytes > MAX_PROJECT_BYTES) return bytes;
      cursor += read;
    }
    offset = end;
  }
  return bytes;
}
function assertProjectSize(bytes) {
  if (bytes > MAX_PROJECT_BYTES) throw new ProjectFormatError('project exceeds the 16 MiB safety limit', 'HEX_PROJECT_TOO_LARGE');
}
function decodeProjectUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ProjectFormatError('project bytes are not valid UTF-8', 'HEX_PROJECT_INVALID_UTF8');
  }
}
function isLegacyPortableCacheReference(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_LEGACY_CACHE_REFERENCE_LENGTH;
}
function sanitizeCacheReferences(project) {
  const source = list(project?.analysis?.cacheReferences, 'analysis.cacheReferences');
  const legacy = source.filter(isLegacyPortableCacheReference);
  const structuredProject = {
    ...project,
    analysis: {
      ...(project.analysis || {}),
      cacheReferences: source.filter(isArtifactRef),
    },
  };
  return [...legacy, ...artifactIndexFromProject(structuredProject).toProjectReferences()];
}

const isPlainRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const isTerminalHypothesisStatus = (status) => status === 'verified' || status === 'rejected';

/* A `.hexproj` document is editable, shareable input, so a verification verdict
   that travelled in it is an assertion and not a runtime outcome. Portable
   session records used to reach `createInvestigationSession()` intact, and that
   normalization seals any `confirmedFindings` array it is handed; `AIRuntime`
   then reads the seal back as deterministic-verification authority, which let an
   imported `status:'verified'` row restore as canonical verified evidence and an
   imported terminal hypothesis keep its verdict (#8687, laundering past #4995).
   The parse step is the one boundary that knows the bytes came from outside, so
   the authority is stripped here. The runtime's own session persistence
   (`createProjectSessionPersistence`) hydrates the live project object and never
   passes through this function, so legitimate deterministic evidence still
   survives its trusted save/reload round-trip. */
function downgradePortableEvidenceAuthority(record) {
  if (!isPlainRecord(record) || record.status !== 'verified') return record;
  return { ...record, status: 'supported' };
}

function downgradePortableHypothesisAuthority(record) {
  if (!isPlainRecord(record) || !isTerminalHypothesisStatus(record.status)) return record;
  // Same non-terminal fallback `HypothesisStore.upsert()` applies without
  // deterministic authority; the confidence a stripped verdict asserted goes too.
  const hasSupport = Array.isArray(record.supportEvidenceIds) && record.supportEvidenceIds.length > 0;
  return { ...record, status: hasSupport ? 'supported' : 'open', confidence: 0.5 };
}

function stripPortableVerificationAuthority(project) {
  const source = project.findings.investigationSessions;
  let changed = false;
  const stripped = source.map((session) => {
    if (!isPlainRecord(session)) return session;
    const hasEvidence = Array.isArray(session.confirmedFindings);
    const hasHypotheses = Array.isArray(session.hypotheses);
    const confirmedFindings = hasEvidence ? session.confirmedFindings.map(downgradePortableEvidenceAuthority) : null;
    const hypotheses = hasHypotheses ? session.hypotheses.map(downgradePortableHypothesisAuthority) : null;
    const evidenceChanged = hasEvidence && confirmedFindings.some((record, index) => record !== session.confirmedFindings[index]);
    const hypothesesChanged = hasHypotheses && hypotheses.some((record, index) => record !== session.hypotheses[index]);
    if (!evidenceChanged && !hypothesesChanged) return session;
    changed = true;
    return {
      ...session,
      ...(evidenceChanged ? { confirmedFindings } : {}),
      ...(hypothesesChanged ? { hypotheses } : {}),
    };
  });
  const confirmedSource = Array.isArray(project.findings.confirmed) ? project.findings.confirmed : [];
  const strippedConfirmed = confirmedSource.map(downgradePortableEvidenceAuthority);
  const confirmedChanged = strippedConfirmed.some((record, index) => record !== confirmedSource[index]);
  const evidenceSource = Array.isArray(project.findings.evidence) ? project.findings.evidence : [];
  const strippedEvidence = evidenceSource.map(downgradePortableEvidenceAuthority);
  const evidenceChanged = strippedEvidence.some((record, index) => record !== evidenceSource[index]);
  if (!changed && !confirmedChanged && !evidenceChanged) return project;
  return {
    ...project,
    findings: {
      ...project.findings,
      ...(changed ? { investigationSessions: stripped } : {}),
      ...(confirmedChanged ? { confirmed: strippedConfirmed } : {}),
      ...(evidenceChanged ? { evidence: strippedEvidence } : {}),
    },
  };
}

export function mintProjectId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `proj_${crypto.randomUUID()}`;
  }
  return `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createHexProject(input = {}) {
  const now = new Date().toISOString();
  if (input.id != null && (typeof input.id !== 'string' || !input.id.trim())) {
    throw new ProjectFormatError('project id must be a non-empty string');
  }
  if (input.projectId != null && (typeof input.projectId !== 'string' || !input.projectId.trim())) {
    throw new ProjectFormatError('project id must be a non-empty string');
  }
  const id = (typeof input.id === 'string' && input.id.trim())
    || (typeof input.projectId === 'string' && input.projectId.trim())
    || mintProjectId();
  const project = {
    id,
    format: 'hexproj', version: HEX_PROJECT_VERSION,
    createdAt: input.createdAt || now, updatedAt: now,
    binary: { hash: input.binaryHash || input.binary?.hash || null, metadata: input.binaryMetadata || input.binary?.metadata || null, embedded: false },
    user: {
      names: validateAnnotationEntries(input.userNames ?? input.user?.names, 'user.names', MAX_NAME_LENGTH, 'HEX_PROJECT_NAME_TOO_LONG'),
      comments: validateAnnotationEntries(input.comments ?? input.user?.comments, 'user.comments', MAX_COMMENT_LENGTH, 'HEX_PROJECT_COMMENT_TOO_LONG'),
      types: validateKeyValueEntries(input.types ?? input.user?.types, 'user.types', MAX_TYPE_LENGTH, 'HEX_PROJECT_TYPE_TOO_LONG'),
      vars: validateKeyValueEntries(input.vars ?? input.user?.vars ?? input.varNames ?? input.user?.varNames, 'user.vars', MAX_NAME_LENGTH, 'HEX_PROJECT_VAR_TOO_LONG'),
      varsPresent: true,
      structs: list(input.structs ?? input.user?.structs, 'user.structs'),
      bookmarks: list(input.bookmarks ?? input.user?.bookmarks, 'user.bookmarks'),
      patches: validatePatchEntries(input.patches ?? input.user?.patches, 'user.patches'),
    },
    findings: {
      confirmed: list(input.confirmedFindings ?? input.findings?.confirmed, 'findings.confirmed'),
      agentAnswers: list(input.agentAnswers ?? input.findings?.agentAnswers, 'findings.agentAnswers'),
      evidence: list(input.evidence ?? input.findings?.evidence, 'findings.evidence'),
      investigationSessions: list(input.investigationSessions ?? input.findings?.investigationSessions, 'findings.investigationSessions'),
    },
    projectAnnotations: list(input.projectAnnotations, 'projectAnnotations'),
    analysis: { settings: input.analysisSettings || input.analysis?.settings || {}, cacheReferences: list(input.cacheReferences ?? input.analysis?.cacheReferences, 'analysis.cacheReferences') },
    navigation: normalizeNavigation(input.navigation ?? {}),
  };
  project.analysis.cacheReferences = sanitizeCacheReferences(project);
  return project;
}

function normalizeCursorIndex(value) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ProjectFormatError('navigation.cursorIndex must be a safe integer or null');
  }
  return value;
}

const DECIMAL_ADDRESS = /^(?:0|[1-9][0-9]*)$/;
const HEX_ADDRESS = /^0[xX][0-9a-fA-F]+$/;

function canonicalAnnotationAddressKey(value, field = 'address') {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new ProjectFormatError(`${field} must be a non-negative canonical address`);
    return value.toString();
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw new ProjectFormatError(`${field} must be a non-negative canonical address`);
    }
    return BigInt(value).toString();
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!DECIMAL_ADDRESS.test(text) && !HEX_ADDRESS.test(text)) {
      throw new ProjectFormatError(`${field} must be a canonical decimal or hex address`);
    }
    try {
      return BigInt(text).toString();
    } catch {
      throw new ProjectFormatError(`${field} must be a canonical decimal or hex address`);
    }
  }
  throw new ProjectFormatError(`${field} must be a bigint, safe integer, or canonical address string`);
}

function defaultAnnotationLimits(name) {
  if (name === 'user.comments') {
    return { maxLength: MAX_COMMENT_LENGTH, tooLongCode: 'HEX_PROJECT_COMMENT_TOO_LONG' };
  }
  return { maxLength: MAX_NAME_LENGTH, tooLongCode: 'HEX_PROJECT_NAME_TOO_LONG' };
}

function validateAnnotationEntries(entries, name, maxLength, tooLongCode) {
  const defaults = defaultAnnotationLimits(name);
  const effectiveMax = maxLength ?? defaults.maxLength;
  const effectiveCode = tooLongCode ?? defaults.tooLongCode;
  const items = list(entries, name);
  for (let index = 0; index < items.length; index += 1) {
    const entry = items[index];
    if (!isPlainRecord(entry)) {
      throw new ProjectFormatError(`${name}[${index}] must be an object`);
    }
    const hasValue = Object.prototype.hasOwnProperty.call(entry, 'value');
    const hasAddress = Object.prototype.hasOwnProperty.call(entry, 'address');
    const legacyText = Object.prototype.hasOwnProperty.call(entry, 'name')
      ? entry.name
      : (Object.prototype.hasOwnProperty.call(entry, 'text') ? entry.text : undefined);
    if (hasValue || (hasAddress && legacyText === undefined)) {
      if (entry.address == null || entry.value == null) {
        throw new ProjectFormatError(`${name}[${index}] must include both address and value`);
      }
      canonicalAnnotationAddressKey(entry.address, `${name}[${index}].address`);
      if (typeof entry.value !== 'string') {
        throw new ProjectFormatError(`${name}[${index}].value must be a string`);
      }
      if (entry.value.length > effectiveMax) {
        throw new ProjectFormatError(
          `${name}[${index}].value exceeds maximum length of ${effectiveMax}`,
          effectiveCode,
        );
      }
      continue;
    }
    // Legacy fixture shape: `{ addr|address, name }` or `{ addr?, text }` (#4818).
    if (legacyText === undefined) {
      throw new ProjectFormatError(`${name}[${index}] must include address and value`);
    }
    if (entry.address != null) {
      canonicalAnnotationAddressKey(entry.address, `${name}[${index}].address`);
    }
    if (entry.addr != null) {
      canonicalAnnotationAddressKey(entry.addr, `${name}[${index}].addr`);
    }
    if (typeof legacyText !== 'string') {
      throw new ProjectFormatError(`${name}[${index}] text value must be a string`);
    }
    if (legacyText.length > effectiveMax) {
      throw new ProjectFormatError(
        `${name}[${index}] exceeds maximum length of ${effectiveMax}`,
        effectiveCode,
      );
    }
  }
  return items;
}

export function validateKeyValueEntries(entries, name, maxValueLength, tooLongCode) {
  const items = list(entries, name);
  for (let index = 0; index < items.length; index += 1) {
    const entry = items[index];
    if (!isPlainRecord(entry)) {
      throw new ProjectFormatError(`${name}[${index}] must be an object`);
    }
    const hasKeyValue = Object.prototype.hasOwnProperty.call(entry, 'key')
      || Object.prototype.hasOwnProperty.call(entry, 'value');
    if (hasKeyValue) {
      if (typeof entry.key !== 'string' || !entry.key) {
        throw new ProjectFormatError(`${name}[${index}].key must be a non-empty string`);
      }
      if (entry.key.length > MAX_VAR_KEY_LENGTH) {
        throw new ProjectFormatError(
          `${name}[${index}].key exceeds maximum length of ${MAX_VAR_KEY_LENGTH}`,
          tooLongCode,
        );
      }
      if (typeof entry.value !== 'string') {
        throw new ProjectFormatError(`${name}[${index}].value must be a string`);
      }
      if (entry.value.length > maxValueLength) {
        throw new ProjectFormatError(
          `${name}[${index}].value exceeds maximum length of ${maxValueLength}`,
          tooLongCode,
        );
      }
      continue;
    }
    // Legacy `user.types` fixture shape: `{ addr, type }`.
    if (name === 'user.types' && Object.prototype.hasOwnProperty.call(entry, 'type')) {
      if (entry.addr != null) {
        canonicalAnnotationAddressKey(entry.addr, `${name}[${index}].addr`);
      }
      if (typeof entry.type !== 'string') {
        throw new ProjectFormatError(`${name}[${index}].type must be a string`);
      }
      if (entry.type.length > maxValueLength) {
        throw new ProjectFormatError(
          `${name}[${index}].type exceeds maximum length of ${maxValueLength}`,
          tooLongCode,
        );
      }
      continue;
    }
    throw new ProjectFormatError(`${name}[${index}] must include key and value`);
  }
  return items;
}

function isValidPatchBytes(value) {
  if (value instanceof Uint8Array) return value.length > 0;
  if (!Array.isArray(value) || value.length === 0) return false;
  for (let i = 0; i < value.length; i += 1) {
    const byte = value[i];
    if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      return false;
    }
  }
  return true;
}

function normalizePatchOffset(value, field) {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new ProjectFormatError(`${field} must be a non-negative integer`, 'HEX_PROJECT_INVALID_PATCH');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw new ProjectFormatError(`${field} must be a non-negative safe integer`, 'HEX_PROJECT_INVALID_PATCH');
    }
    return BigInt(value);
  }
  throw new ProjectFormatError(`${field} must be a non-negative integer or bigint`, 'HEX_PROJECT_INVALID_PATCH');
}

export function validatePatchEntries(entries, name = 'user.patches') {
  if (entries == null) return [];
  if (!Array.isArray(entries)) {
    throw new ProjectFormatError(`${name} must be an array`, 'HEX_PROJECT_INVALID_PATCH');
  }
  if (entries.length > MAX_PATCH_ENTRIES) {
    throw new ProjectFormatError(`${name} exceeds maximum of ${MAX_PATCH_ENTRIES} entries`, 'HEX_PROJECT_INVALID_PATCH');
  }
  const items = [...entries];
  const ranges = [];
  for (let index = 0; index < items.length; index += 1) {
    const entry = items[index];
    if (!isPlainRecord(entry)) {
      throw new ProjectFormatError(`${name}[${index}] must be a plain object`, 'HEX_PROJECT_INVALID_PATCH');
    }
    // Preserve legacy `{ addr, bytes }` roundtrip fixtures when no canonical patch keys exist.
    const hasCanonicalKeys = Object.prototype.hasOwnProperty.call(entry, 'offset')
      || Object.prototype.hasOwnProperty.call(entry, 'before')
      || Object.prototype.hasOwnProperty.call(entry, 'after');
    if (!hasCanonicalKeys
      && entry.addr != null
      && Object.prototype.hasOwnProperty.call(entry, 'bytes')
      && isValidPatchBytes(entry.bytes)) {
      try {
        canonicalAnnotationAddressKey(entry.addr, `${name}[${index}].addr`);
      } catch {
        throw new ProjectFormatError(`${name}[${index}].addr is invalid`, 'HEX_PROJECT_INVALID_PATCH');
      }
      continue;
    }
    const start = normalizePatchOffset(entry.offset, `${name}[${index}].offset`);
    if (!isValidPatchBytes(entry.before)) {
      throw new ProjectFormatError(`${name}[${index}].before must be a non-empty byte array`, 'HEX_PROJECT_INVALID_PATCH');
    }
    if (!isValidPatchBytes(entry.after)) {
      throw new ProjectFormatError(`${name}[${index}].after must be a non-empty byte array`, 'HEX_PROJECT_INVALID_PATCH');
    }
    if (entry.before.length !== entry.after.length) {
      throw new ProjectFormatError(`${name}[${index}] before/after length mismatch`, 'HEX_PROJECT_INVALID_PATCH');
    }
    ranges.push({ start, end: start + BigInt(entry.after.length), index });
  }
  if (ranges.length > 1) {
    ranges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    for (let i = 1; i < ranges.length; i += 1) {
      if (ranges[i - 1].end > ranges[i].start) {
        throw new ProjectFormatError(
          `${name}[${ranges[i].index}] overlaps another patch range`,
          'HEX_PROJECT_INVALID_PATCH',
        );
      }
    }
  }
  return items;
}

export function projectAnnotationCommitList(entries, name, options = {}) {
  const defaults = defaultAnnotationLimits(name);
  const maxLength = options?.maxLength ?? defaults.maxLength;
  const tooLongCode = options?.tooLongCode ?? defaults.tooLongCode;
  const items = validateAnnotationEntries(entries, name, maxLength, tooLongCode);
  const out = [];
  for (const entry of items) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (entry.address == null || entry.value == null || entry.value === '') continue;
    out.push([canonicalAnnotationAddressKey(entry.address, `${name}[].address`), entry.value]);
  }
  return out;
}

function normalizeCurrentFunction(value) {
  if (value == null) return null;
  if (typeof value === 'bigint') {
    if (value < 0n) throw new ProjectFormatError('navigation.currentFunction must be an integer');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw new ProjectFormatError('navigation.currentFunction must be an integer');
    }
    return BigInt(value);
  }
  if (typeof value !== 'string' || (!DECIMAL_ADDRESS.test(value) && !HEX_ADDRESS.test(value))) {
    throw new ProjectFormatError('navigation.currentFunction must be an integer');
  }
  try {
    return BigInt(value);
  } catch {
    throw new ProjectFormatError('navigation.currentFunction must be an integer');
  }
}

export function normalizeNavigation(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProjectFormatError('navigation must be an object');
  // currentFunction is consumed as BigInt by the workspace apply; validating
  // the integer representation HERE (at parse time) prevents a malformed value
  // from failing mid-apply, after notes/patches were already persisted (#5953).
  const currentFunction = normalizeCurrentFunction(value.currentFunction);
  return {
    currentFunction,
    history: list(value.history, 'navigation.history').slice(-500),
    cursorIndex: normalizeCursorIndex(value.cursorIndex),
    bookmarks: list(value.bookmarks, 'navigation.bookmarks').slice(-500),
    lastQuery: value.lastQuery ?? null,
  };
}

/*
 * `.hexproj` encodes a BigInt as the single-key object `{ $hexBigInt: hex }`.
 * The reader cannot tell that wrapper apart from an ordinary object a user
 * genuinely had, so `{ $hexBigInt: '10' }` came back as `16n` and save+reload
 * silently rewrote their data (#1366).
 *
 * Renaming the tag would only move the collision, so the tag name is reserved
 * instead: on the way out, any object key matching `$hexBigInt` with one or
 * more leading `$` gains one more `$`; on the way in, a marked document takes
 * one back. That is injective -- `$hexBigInt` -> `$$hexBigInt` ->
 * `$$$hexBigInt` -- so ordinary data and the tag can never occupy the same
 * shape.
 *
 * Files written before this change have no provenance marker. Their literal
 * keys are preserved; a historical escape-aware writer that also omitted the
 * marker is inherently ambiguous with those legacy files and cannot be
 * recovered by guessing from the key shape.
 */
const BIGINT_TAG = '$hexBigInt';
const ESCAPED_TAG = /^\$(\$*)\$hexBigInt$/;
const BIGINT_ENCODING_FIELD = 'bigIntEncoding';
const BIGINT_ENCODING_VERSION = 1;
// Hex projects persist machine integers (addresses/offsets/ids, ≤ 64–128 bits).
// A per-value magnitude budget checked BEFORE BigInt() keeps a hostile scalar
// inside the size-limited file from paying unbounded conversion cost (#5906).
const MAX_BIGINT_HEX_DIGITS = 128;

function escapeBigIntTag(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const keys = Object.keys(value);
  if (!keys.some((key) => key === BIGINT_TAG || ESCAPED_TAG.test(key))) return value;
  const out = {};
  for (const key of keys) {
    const escaped = key === BIGINT_TAG || ESCAPED_TAG.test(key) ? `$${key}` : key;
    Object.defineProperty(out, escaped, { value: value[key], enumerable: true, configurable: true, writable: true });
  }
  return out;
}

/**
 * Rebuilds a parsed tree and takes one `$` off escaped tag keys. Rebuilding
 * instead of deleting from the input prevents key-order-dependent loss when
 * siblings such as `$$$hexBigInt` and `$$hexBigInt` are both present.
 */
const MAX_BIGINT_TREE_DEPTH = 128;

function unescapeBigIntTagTree(value, depth = 0) {
  if (!value || typeof value !== 'object') return value;
  if (depth >= MAX_BIGINT_TREE_DEPTH) {
    throw new ProjectFormatError('project JSON exceeds maximum nesting depth', 'HEX_PROJECT_TOO_DEEP');
  }
  if (Array.isArray(value)) return value.map((item) => unescapeBigIntTagTree(item, depth + 1));

  const out = {};
  for (const key of Object.keys(value)) {
    const unescaped = ESCAPED_TAG.test(key) ? key.slice(1) : key;
    if (Object.hasOwn(out, unescaped)) {
      throw new ProjectFormatError(
        `BigInt encoding key collision at ${JSON.stringify(unescaped)}`,
        'HEX_PROJECT_BIGINT_ENCODING_COLLISION',
      );
    }
    Object.defineProperty(out, unescaped, {
      value: unescapeBigIntTagTree(value[key], depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}

function hasSupportedBigIntEncoding(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (!Object.hasOwn(raw, BIGINT_ENCODING_FIELD)) return false;
  const version = raw[BIGINT_ENCODING_FIELD];
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ProjectFormatError(
      'invalid BigInt encoding provenance',
      'HEX_PROJECT_BIGINT_ENCODING_INVALID',
    );
  }
  if (version !== BIGINT_ENCODING_VERSION) {
    throw new ProjectFormatError(
      `unsupported BigInt encoding provenance version ${version}`,
      'HEX_PROJECT_BIGINT_ENCODING_UNSUPPORTED',
    );
  }
  return true;
}

export function serializeHexProject(project, { compact = false } = {}) {
  const normalized = {
    ...validateHexProject(project),
    [BIGINT_ENCODING_FIELD]: BIGINT_ENCODING_VERSION,
  };
  const replacer = (_key, value) => (
    typeof value === 'bigint' ? { [BIGINT_TAG]: value.toString(16) } : escapeBigIntTag(value)
  );
  const text = compact
    ? JSON.stringify(normalized, replacer)
    : JSON.stringify(normalized, replacer, 2);
  assertProjectSize(encodedByteLength(text));
  return text;
}

export function parseHexProject(input) {
  let text;
  if (typeof input === 'string') text = input;
  else if (input instanceof Uint8Array) { assertProjectSize(input.byteLength); text = decodeProjectUtf8(input); }
  else if (input instanceof ArrayBuffer) { assertProjectSize(input.byteLength); text = decodeProjectUtf8(new Uint8Array(input)); }
  else throw new ProjectFormatError('project input must be JSON text or bytes');
  assertProjectSize(encodedByteLength(text));
  let raw;
  try {
    raw = JSON.parse(text, (_key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === 1 && Object.hasOwn(value, BIGINT_TAG) && typeof value[BIGINT_TAG] === 'string') {
        const encoded = value[BIGINT_TAG];
        if (!/^-?[0-9a-f]+$/i.test(encoded) || encoded === '-') throw new ProjectFormatError('invalid bigint encoding');
        const negative = encoded.startsWith('-'); const magnitude = negative ? encoded.slice(1) : encoded;
        if (magnitude.length > MAX_BIGINT_HEX_DIGITS) throw new ProjectFormatError('bigint magnitude exceeds the project resource limit', 'resource-limit');
        const parsed = BigInt('0x' + magnitude); return negative ? -parsed : parsed;
      }
      return value;
    });
  } catch (error) {
    if (error instanceof ProjectFormatError) throw error;
    throw new ProjectFormatError(`project JSON is malformed: ${error.message}`);
  }
  // Only an explicit provenance marker authorizes the one-$ unescape. Version
  // numbers do not identify the BigInt encoding protocol: historical v1/v2
  // files without this marker are preserved as-is, because some legacy files
  // contain literal `$$hexBigInt` keys and old escape-aware files are
  // indistinguishable from them.
  if (hasSupportedBigIntEncoding(raw)) raw = unescapeBigIntTagTree(raw);
  let migrated;
  try {
    migrated = migrateHexProject(raw, { currentVersion: HEX_PROJECT_VERSION });
  } catch (error) {
    if (error instanceof ProjectMigrationError) {
      throw new ProjectFormatError(error.message, error.code);
    }
    throw error;
  }
  const normalized = normalizeHexProjectV1(migrated);
  if (!normalized.id) {
    normalized.id = mintProjectId();
  }
  return stripPortableVerificationAuthority(normalized);
}

export function tryParseHexProject(input) { try { return { ok: true, project: parseHexProject(input) }; } catch (error) { return { ok: false, error: error?.message || String(error), code: error?.code || 'HEX_PROJECT_INVALID' }; } }
export function exportHexProject(project, name = 'analysis.hexproj') { const text = serializeHexProject(project); if (typeof File !== 'undefined') return new File([text], name, { type: HEX_PROJECT_MIME }); if (typeof Blob !== 'undefined') return new Blob([text], { type: HEX_PROJECT_MIME }); return new TextEncoder().encode(text); }
export async function importHexProject(input) {
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    assertProjectSize(input.size);
    return parseHexProject(await input.arrayBuffer());
  }
  return parseHexProject(input);
}

export function normalizeHexProjectV1(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) throw new ProjectFormatError('project root must be an object');
  if (project.format !== 'hexproj') throw new ProjectFormatError('not a .hexproj document');
  if (!Number.isInteger(project.version) || project.version < 1) throw new ProjectFormatError('invalid project version');
  if (project.version > HEX_PROJECT_VERSION) throw new ProjectFormatError(`project version ${project.version} is newer than supported version ${HEX_PROJECT_VERSION}`, 'HEX_PROJECT_FUTURE_VERSION');
  if (!project.binary || typeof project.binary !== 'object' || Array.isArray(project.binary)) throw new ProjectFormatError('project binary metadata is missing');
  if (project.binary.embedded) throw new ProjectFormatError('embedded binaries are not accepted by this project version');

  if (project.id != null && (typeof project.id !== 'string' || !project.id.trim())) {
    throw new ProjectFormatError('project id must be a non-empty string');
  }
  if (project.projectId != null && (typeof project.projectId !== 'string' || !project.projectId.trim())) {
    throw new ProjectFormatError('project id must be a non-empty string');
  }
  const id = (typeof project.id === 'string' && project.id.trim())
    || (typeof project.projectId === 'string' && project.projectId.trim())
    || null;

  const createdAt = project.createdAt || new Date(0).toISOString();
  const updatedAt = project.updatedAt || createdAt;

  const normalized = {
    ...(id ? { id } : {}),
    format: 'hexproj',
    version: HEX_PROJECT_VERSION,
    createdAt,
    updatedAt,
    binary: {
      hash: project.binary.hash ?? null,
      metadata: project.binary.metadata ?? null,
      embedded: false,
    },
    user: {
      names: validateAnnotationEntries(project.user?.names, 'user.names', MAX_NAME_LENGTH, 'HEX_PROJECT_NAME_TOO_LONG'),
      comments: validateAnnotationEntries(project.user?.comments, 'user.comments', MAX_COMMENT_LENGTH, 'HEX_PROJECT_COMMENT_TOO_LONG'),
      types: validateKeyValueEntries(project.user?.types, 'user.types', MAX_TYPE_LENGTH, 'HEX_PROJECT_TYPE_TOO_LONG'),
      vars: validateKeyValueEntries(project.user?.vars ?? project.user?.varNames, 'user.vars', MAX_NAME_LENGTH, 'HEX_PROJECT_VAR_TOO_LONG'),
      varsPresent: project.user?.varsPresent !== false && (Object.prototype.hasOwnProperty.call(project.user || {}, 'vars') || Object.prototype.hasOwnProperty.call(project.user || {}, 'varNames')),
      structs: list(project.user?.structs, 'user.structs'),
      bookmarks: list(project.user?.bookmarks, 'user.bookmarks'),
      patches: validatePatchEntries(project.user?.patches, 'user.patches'),
    },
    findings: {
      confirmed: list(project.findings?.confirmed, 'findings.confirmed'),
      agentAnswers: list(project.findings?.agentAnswers, 'findings.agentAnswers'),
      evidence: list(project.findings?.evidence, 'findings.evidence'),
      investigationSessions: list(project.findings?.investigationSessions, 'findings.investigationSessions'),
    },
    projectAnnotations: list(project.projectAnnotations, 'projectAnnotations'),
    analysis: {
      settings: project.analysis?.settings && typeof project.analysis.settings === 'object' && !Array.isArray(project.analysis.settings)
        ? { ...project.analysis.settings }
        : {},
      cacheReferences: list(project.analysis?.cacheReferences, 'analysis.cacheReferences'),
    },
    navigation: normalizeNavigation(project.navigation ?? {}),
  };

  normalized.analysis.cacheReferences = sanitizeCacheReferences(normalized);
  return normalized;
}

export function validateHexProject(project) {
  return normalizeHexProjectV1(project);
}

export { ProjectMigrationError, migrateHexProject, PROJECT_MIGRATIONS };
