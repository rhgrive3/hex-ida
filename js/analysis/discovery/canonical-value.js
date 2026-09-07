/** Type-preserving, JSON-safe canonical values for discovery identity. */

import { deepFreeze, stableDigest } from '../../core/identity/index.js';

export const DISCOVERY_TYPED_VALUE_SCHEMA = 'hex-discovery-typed-value/v1';

function fail(code) { throw new TypeError(code); }

const MAX_DEPTH = 128;
const MAX_NODES = 100000;
const MAX_TEXT = 1048576;
function consume(budget, depth, text = '') {
  budget.nodes += 1;
  budget.text += text.length;
  if (depth > MAX_DEPTH || budget.nodes > MAX_NODES || budget.text > MAX_TEXT) {
    fail('discovery-typed-value-budget-exhausted');
  }
}
function boundedLength(value, budget) {
  const length = descriptor(value, 'length', 'discovery-typed-value-array-invalid').value;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_NODES - budget.nodes) {
    fail('discovery-typed-value-budget-exhausted');
  }
  return length;
}

function descriptor(value, key, code) {
  let result;
  try { result = Object.getOwnPropertyDescriptor(value, key); }
  catch { fail(code); }
  if (result == null || !Object.hasOwn(result, 'value')) fail(code);
  return result;
}

function encode(value, seen, budget, depth = 0) {
  consume(budget, depth, typeof value === 'string' ? value : '');
  if (value === null) return { t: 'null' };
  if (typeof value === 'boolean') return { t: 'boolean', v: value };
  if (typeof value === 'string') return { t: 'string', v: value };
  if (typeof value === 'bigint') {
    const text = value.toString();
    consume(budget, depth, text);
    return { t: 'bigint', v: text };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('discovery-typed-value-number-invalid');
    return { t: 'number', v: Object.is(value, -0) ? '-0' : String(value) };
  }
  if (typeof value !== 'object' || seen.has(value)) fail('discovery-typed-value-invalid');
  seen.add(value);
  let encoded;
  if (Array.isArray(value)) {
    const items = [];
    const length = boundedLength(value, budget);
    for (let index = 0; index < length; index += 1) {
      const item = Object.getOwnPropertyDescriptor(value, String(index));
      if (item == null) { consume(budget, depth + 1); items.push({ t: 'hole' }); }
      else {
        if (!Object.hasOwn(item, 'value')) fail('discovery-typed-value-accessor-invalid');
        items.push(encode(item.value, seen, budget, depth + 1));
      }
    }
    encoded = { t: 'array', v: items };
  } else {
    let keys;
    try { keys = Object.keys(value).sort(); }
    catch { fail('discovery-typed-value-object-invalid'); }
    const entries = keys.map((key) => {
      consume(budget, depth, key);
      const item = descriptor(value, key, 'discovery-typed-value-accessor-invalid');
      return [key, encode(item.value, seen, budget, depth + 1)];
    });
    encoded = { t: 'object', v: entries };
  }
  seen.delete(value);
  return encoded;
}

function validateNode(node, seen = new WeakSet(), budget = { nodes: 0, text: 0 }, depth = 0) {
  consume(budget, depth);
  if (!node || typeof node !== 'object' || Array.isArray(node) || seen.has(node)) {
    fail('discovery-typed-value-frame-invalid');
  }
  seen.add(node);
  const type = descriptor(node, 't', 'discovery-typed-value-frame-invalid').value;
  const keys = Object.keys(node).sort();
  if (type === 'null' || type === 'hole') {
    if (keys.length !== 1) fail('discovery-typed-value-frame-invalid');
  } else {
    if (keys.length !== 2 || keys[0] !== 't' || keys[1] !== 'v') fail('discovery-typed-value-frame-invalid');
    const value = descriptor(node, 'v', 'discovery-typed-value-frame-invalid').value;
    if (typeof value === 'string') consume(budget, depth, value);
    if (type === 'boolean') {
      if (typeof value !== 'boolean') fail('discovery-typed-value-frame-invalid');
    } else if (type === 'string') {
      if (typeof value !== 'string') fail('discovery-typed-value-frame-invalid');
    } else if (type === 'bigint') {
      if (typeof value !== 'string' || value === '-0' || !/^-?(?:0|[1-9][0-9]*)$/.test(value)) {
        fail('discovery-typed-value-frame-invalid');
      }
    } else if (type === 'number') {
      if (typeof value !== 'string' || (value !== '-0'
          && (!Number.isFinite(Number(value)) || String(Number(value)) !== value))) {
        fail('discovery-typed-value-frame-invalid');
      }
    } else if (type === 'array') {
      if (!Array.isArray(value)) fail('discovery-typed-value-frame-invalid');
      const length = boundedLength(value, budget);
      for (let index = 0; index < length; index += 1) {
        const item = descriptor(value, String(index), 'discovery-typed-value-frame-invalid').value;
        validateNode(item, seen, budget, depth + 1);
      }
    } else if (type === 'object') {
      if (!Array.isArray(value)) fail('discovery-typed-value-frame-invalid');
      let previous = null;
      const length = boundedLength(value, budget);
      for (let index = 0; index < length; index += 1) {
        const entry = descriptor(value, String(index), 'discovery-typed-value-frame-invalid').value;
        if (!Array.isArray(entry) || entry.length !== 2) fail('discovery-typed-value-frame-invalid');
        const key = descriptor(entry, '0', 'discovery-typed-value-frame-invalid').value;
        const child = descriptor(entry, '1', 'discovery-typed-value-frame-invalid').value;
        if (typeof key !== 'string' || (previous != null && key <= previous)) fail('discovery-typed-value-frame-invalid');
        previous = key;
        consume(budget, depth, key);
        validateNode(child, seen, budget, depth + 1);
      }
    } else fail('discovery-typed-value-frame-invalid');
  }
  seen.delete(node);
}

function isFrame(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const schema = Object.getOwnPropertyDescriptor(value, 'schema');
  return schema != null && Object.hasOwn(schema, 'value') && schema.value === DISCOVERY_TYPED_VALUE_SCHEMA;
}

export function canonicalTypedValue(value) {
  if (isFrame(value)) {
    const schema = descriptor(value, 'schema', 'discovery-typed-value-frame-invalid').value;
    const node = descriptor(value, 'value', 'discovery-typed-value-frame-invalid').value;
    if (schema !== DISCOVERY_TYPED_VALUE_SCHEMA || Object.keys(value).sort().join(',') !== 'schema,value') {
      fail('discovery-typed-value-frame-invalid');
    }
    validateNode(node);
    return deepFreeze(JSON.parse(JSON.stringify(value)));
  }
  return deepFreeze({ schema: DISCOVERY_TYPED_VALUE_SCHEMA, value: encode(value, new WeakSet(), { nodes: 0, text: 0 }) });
}

export function canonicalTypedString(value) {
  return JSON.stringify(canonicalTypedValue(value));
}

export function canonicalTypedDigest(value) {
  return stableDigest(canonicalTypedString(value));
}
