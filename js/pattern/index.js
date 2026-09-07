import * as core from './index-core.js';
import { deepFreeze, stableDigest } from '../core/identity/index.js';

export * from './index-core.js';

const COMPILED_PATTERNS = new WeakSet();
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function fail(code) {
  const error = new TypeError(code);
  error.code = code;
  throw error;
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneEnvelope(value) {
  if (!isPlainRecord(value)) fail('pattern-compiled-invalid');
  if (typeof structuredClone !== 'function') fail('pattern-compiled-clone-unavailable');
  try {
    return structuredClone(value);
  } catch {
    fail('pattern-compiled-invalid');
  }
}

function validateCompileOptions(value) {
  if (!isPlainRecord(value)) fail('pattern-compiled-options-invalid');
  if (typeof value.targetAddressSpace !== 'string' || !value.targetAddressSpace) {
    fail('pattern-compiled-target-address-space-invalid');
  }
  if (value.semanticVersion !== core.PATTERN_LANGUAGE_VERSION) {
    fail('pattern-compiled-options-version-mismatch');
  }
  if (!hasOwn(value, 'options') || !isPlainRecord(value.options)) {
    fail('pattern-compiled-options-invalid');
  }
  return deepFreeze(value);
}

function validateSnapshotId(value) {
  if (value !== null && (typeof value !== 'string' || !value)) {
    fail('pattern-compiled-snapshot-id-invalid');
  }
  return value;
}

function validateCompiledPattern(value) {
  if (value && typeof value === 'object' && COMPILED_PATTERNS.has(value)) return value;

  const pattern = cloneEnvelope(value);
  if (pattern.languageVersion !== core.PATTERN_LANGUAGE_VERSION) {
    fail('pattern-compiled-language-version-unsupported');
  }
  if (typeof pattern.patternId !== 'string' || !pattern.patternId) {
    fail('pattern-compiled-id-invalid');
  }
  if (typeof pattern.sourceHash !== 'string' || !pattern.sourceHash) {
    fail('pattern-compiled-source-hash-invalid');
  }
  if (!pattern.ast || typeof pattern.ast !== 'object' || Array.isArray(pattern.ast)) {
    fail('pattern-compiled-ast-invalid');
  }

  const compileOptions = validateCompileOptions(pattern.compileOptions);
  const snapshotId = validateSnapshotId(pattern.snapshotId);
  const checked = core.typeCheckPattern({
    languageVersion: core.PATTERN_LANGUAGE_VERSION,
    ast: pattern.ast,
  });
  const ast = checked.ast;
  const sourceHash = stableDigest(ast);
  if (pattern.sourceHash !== sourceHash) {
    fail('pattern-compiled-source-hash-mismatch');
  }
  const expectedId = `pattern:${stableDigest({ sourceHash, compileOptions })}`;
  if (pattern.patternId !== expectedId) {
    fail('pattern-compiled-id-mismatch');
  }

  return deepFreeze({
    languageVersion: core.PATTERN_LANGUAGE_VERSION,
    sourceHash,
    patternId: expectedId,
    ast,
    snapshotId,
    compileOptions,
  });
}

function looksCompiled(value) {
  if (!value || typeof value !== 'object') return false;
  try {
    return hasOwn(value, 'patternId') || hasOwn(value, 'sourceHash') || hasOwn(value, 'compileOptions');
  } catch {
    fail('pattern-compiled-invalid');
  }
}

export function compilePattern(source, options = {}) {
  const compiled = core.compilePattern(source, options);
  validateCompiledPattern(compiled);
  COMPILED_PATTERNS.add(compiled);
  return compiled;
}

export function evaluatePattern(compiled, byteSource, options = {}) {
  const pattern = looksCompiled(compiled)
    ? validateCompiledPattern(compiled)
    : compilePattern(compiled, options);
  return core.evaluatePattern(pattern, byteSource, options);
}

export function evaluatePatternAsync(compiled, byteSource, options = {}) {
  return Promise.resolve(evaluatePattern(compiled, byteSource, options));
}
