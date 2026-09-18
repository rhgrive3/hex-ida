/**
 * Strict, bounded data boundary for scope-qualified analysis contracts.
 *
 * This is validation/detachment, NOT a new identity serializer. Identities are
 * still minted by core/identity. Accessors, custom prototypes, sparse arrays,
 * symbols and coercible objects are deliberately not part of the wire grammar.
 */
import { canonicalAddress, deepFreeze } from './index.js';

export class AnalysisContractError extends TypeError {
  constructor(code, details = null) {
    super(code);
    this.name = 'AnalysisContractError';
    this.code = code;
    this.details = details;
  }
}

export function contractFail(code, details = null) {
  throw new AnalysisContractError(code, details);
}

export function exactString(value, code = 'analysis-contract-string-required', maxLength = 4096) {
  if (typeof value !== 'string' || !value.length || value.length > maxLength
    || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) contractFail(code);
  return value;
}

export function optionalString(value, code, maxLength) {
  return value === null || value === undefined ? null : exactString(value, code, maxLength);
}

export function exactInteger(value, code = 'analysis-contract-integer-required', { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0)
    || value < min || value > max) contractFail(code);
  return value;
}

export function exactBoolean(value, code = 'analysis-contract-boolean-required') {
  if (typeof value !== 'boolean') contractFail(code);
  return value;
}

export function exactEnum(value, values, code) {
  if (typeof value !== 'string' || !values.includes(value)) contractFail(code);
  return value;
}

export function compareIdentity(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

export function plainRecord(value, code = 'analysis-contract-record-required') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) contractFail(code);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) contractFail(code);
  return value;
}

/** Reject unknown fields as well as properties whose access could execute code. */
export function recordFields(value, allowed, code = 'analysis-contract-unexpected-field') {
  plainRecord(value, code);
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.includes(key)) contractFail(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) contractFail(code);
  }
  return value;
}

export function stringSet(value, code = 'analysis-contract-ids-invalid', maxItems = 16384) {
  if (!Array.isArray(value) || value.length > maxItems) contractFail(code);
  const result = new Set();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) contractFail(code);
    result.add(exactString(descriptor.value, code));
  }
  return [...result].sort(compareIdentity);
}

export function unsignedAddress(value, { bits = 64, allowEnd = false, code = 'analysis-contract-address-invalid' } = {}) {
  exactInteger(bits, code, { min: 1, max: 128 });
  let text;
  try { text = canonicalAddress(value); } catch { contractFail(code); }
  const n = BigInt(text);
  const end = 1n << BigInt(bits);
  if (n > end || (!allowEnd && n === end)) contractFail(code);
  return text;
}

export function signedIntegerText(value, code = 'analysis-contract-signed-integer-invalid') {
  let n;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)) n = BigInt(value);
  else if (typeof value === 'string' && /^-?(?:0|[1-9][0-9]*)$/.test(value) && value.length <= 80 && value !== '-0') n = BigInt(value);
  else contractFail(code);
  if (n < -(1n << 127n) || n >= (1n << 127n)) contractFail(code);
  return n.toString();
}

export function sha256Text(value, code = 'analysis-contract-sha256-invalid') {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) contractFail(code);
  return value;
}

/**
 * Detach trusted or untrusted plain data before any constructor reads it.
 * Traversal has a finite depth, node, property, and approximate byte budget.
 * A caller must not pass a live plugin Proxy here: plugin RPC is a structured
 * clone boundary. JavaScript cannot safely introspect an arbitrary live Proxy.
 */
export function snapshotContractData(value, {
  maxDepth = 32, maxNodes = 100000, maxProperties = 200000,
  maxStringLength = 65536, maxBytes = 8 * 1024 * 1024, allowBigInt = false,
  preserveAliases = false, allowUndefined = false,
} = {}) {
  for (const [name, n] of Object.entries({ maxDepth, maxNodes, maxProperties, maxStringLength, maxBytes })) {
    exactInteger(n, `analysis-contract-limit-invalid:${name}`);
  }
  if (typeof preserveAliases !== 'boolean' || typeof allowUndefined !== 'boolean' || typeof allowBigInt !== 'boolean') contractFail('analysis-contract-clone-mode');
  // Internal owner adapters may retain a same-object canonical mirror. Revisit
  // aliases for budget accounting: a compact DAG must not bypass the expanded
  // serialization budget. Cycles still fail before consulting this map.
  const memo = preserveAliases ? new WeakMap() : null;
  const active = new WeakSet();
  let nodes = 0;
  let properties = 0;
  let bytes = 0;
  const charge = (amount) => {
    bytes += amount;
    if (!Number.isSafeInteger(bytes) || bytes > maxBytes) contractFail('analysis-contract-byte-budget');
  };
  function copy(item, depth) {
    if (++nodes > maxNodes) contractFail('analysis-contract-node-budget');
    if (depth > maxDepth) contractFail('analysis-contract-depth-budget');
    if (item === undefined && allowUndefined) { charge(8); return undefined; }
    if (item === null || typeof item === 'boolean') { charge(8); return item; }
    if (typeof item === 'string') {
      if (item.length > maxStringLength) contractFail('analysis-contract-string-budget');
      charge(8 + item.length * 2);
      return item;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || Object.is(item, -0)
        || (Number.isInteger(item) && !Number.isSafeInteger(item))) contractFail('analysis-contract-number-invalid');
      charge(8);
      return item;
    }
    if (typeof item === 'bigint' && allowBigInt) {
      if (item < -(1n << 255n) || item >= (1n << 256n)) contractFail('analysis-contract-bigint-out-of-range');
      charge(40);
      return item;
    }
    if (typeof item !== 'object') contractFail('analysis-contract-non-data-value');
    if (active.has(item)) contractFail('analysis-contract-cycle');
    const array = Array.isArray(item);
    if (array) {
      if (Object.getPrototypeOf(item) !== Array.prototype) contractFail('analysis-contract-array-prototype');
      if (item.length > maxNodes) contractFail('analysis-contract-node-budget');
    } else plainRecord(item);
    active.add(item);
    charge(32);
    const keys = Reflect.ownKeys(item);
    const output = memo?.get(item) ?? (array ? [] : {});
    memo?.set(item, output);
    if (array && keys.length !== item.length + 1) contractFail('analysis-contract-sparse-or-decorated-array');
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (array && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) contractFail('analysis-contract-decorated-array');
      if (typeof key !== 'string') contractFail('analysis-contract-symbol-field');
      if (++properties > maxProperties) contractFail('analysis-contract-property-budget');
      if (key.length > maxStringLength) contractFail('analysis-contract-key-budget');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        contractFail('analysis-contract-accessor-or-hidden-field');
      }
      charge(8 + key.length * 2);
      Object.defineProperty(output, key, {
        value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true,
      });
    }
    active.delete(item);
    return output;
  }
  return deepFreeze(copy(value, 0));
}

export function assertMatchingId(supplied, actual, code) {
  if (supplied !== undefined && supplied !== actual) contractFail(code);
  return actual;
}
