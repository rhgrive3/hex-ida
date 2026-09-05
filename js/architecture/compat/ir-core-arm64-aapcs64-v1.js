/*
 * Strict authority facade for the historical ARM64/AAPCS64 IR implementation.
 *
 * Keep the legacy implementation byte-identical in the sibling base module and
 * normalize only ABI return-width authority at this public compatibility
 * boundary. Canonical primitive widths preserve the historical path; malformed
 * structured values fail closed to the established 64-bit default without
 * invoking valueOf()/toString()/Symbol.toPrimitive coercion hooks.
 */
export * from './ir-core-arm64-aapcs64-v1-base.js';

import {
  buildIR as buildLegacyIR,
  irFor as legacyIrFor,
} from './ir-core-arm64-aapcs64-v1-base.js';

const CALL_PROTOTYPE_PROVIDER_WRAPPERS = new WeakMap();

function primitiveAbiWidth(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function cloneWithField(object, key, value) {
  const descriptors = Object.getOwnPropertyDescriptors(object);
  const previous = descriptors[key];
  delete descriptors[key];
  return Object.create(Object.getPrototypeOf(object), {
    ...descriptors,
    [key]: {
      value,
      enumerable: previous?.enumerable ?? true,
      configurable: true,
      writable: true,
    },
  });
}

function readAuthorityField(object, key) {
  try { return { readable:true, value:object?.[key] }; }
  catch { return { readable:false, value:null }; }
}

function sanitizeReturnPrototype(proto) {
  if (!proto || typeof proto !== 'object') return proto;

  const explicit = readAuthorityField(proto, 'returnBits');
  if (!explicit.readable) return cloneWithField(proto, 'returnBits', 64);
  if (explicit.value != null) {
    return primitiveAbiWidth(explicit.value) ? proto : cloneWithField(proto, 'returnBits', 64);
  }

  const fallback = readAuthorityField(proto, 'bits');
  if (!fallback.readable) return cloneWithField(proto, 'bits', 64);
  if (fallback.value != null && !primitiveAbiWidth(fallback.value)) {
    return cloneWithField(proto, 'bits', 64);
  }
  return proto;
}

function sanitizeInstructionModel(model) {
  if (!model || !Array.isArray(model.instructions)) return model;
  let changed = false;
  const instructions = model.instructions.map((instruction) => {
    if (!instruction || typeof instruction !== 'object') return instruction;
    const field = readAuthorityField(instruction, 'callPrototype');
    if (!field.readable) return instruction;
    const sanitized = sanitizeReturnPrototype(field.value);
    if (sanitized === field.value) return instruction;
    changed = true;
    return cloneWithField(instruction, 'callPrototype', sanitized);
  });
  return changed ? cloneWithField(model, 'instructions', instructions) : model;
}

function wrappedPrototypeProvider(provider) {
  let wrapper = CALL_PROTOTYPE_PROVIDER_WRAPPERS.get(provider);
  if (wrapper) return wrapper;
  wrapper = function (...args) {
    return sanitizeReturnPrototype(provider.apply(this, args));
  };
  CALL_PROTOTYPE_PROVIDER_WRAPPERS.set(provider, wrapper);
  return wrapper;
}

function sanitizeOptions(options = {}) {
  if (!options || typeof options !== 'object') return options;
  let normalized = options;

  for (const key of ['functionPrototype', 'prototype']) {
    const field = readAuthorityField(normalized, key);
    if (!field.readable) continue;
    const sanitized = sanitizeReturnPrototype(field.value);
    if (sanitized !== field.value) normalized = cloneWithField(normalized, key, sanitized);
  }

  const returnBits = readAuthorityField(normalized, 'returnBits');
  if (!returnBits.readable) {
    normalized = cloneWithField(normalized, 'returnBits', 64);
  } else if (returnBits.value != null && !primitiveAbiWidth(returnBits.value)) {
    normalized = cloneWithField(normalized, 'returnBits', 64);
  }

  const provider = readAuthorityField(normalized, 'callPrototypeFor');
  if (provider.readable && typeof provider.value === 'function') {
    const wrapped = wrappedPrototypeProvider(provider.value);
    if (wrapped !== provider.value) normalized = cloneWithField(normalized, 'callPrototypeFor', wrapped);
  }
  return normalized;
}

export function buildIR(model, options = {}) {
  return buildLegacyIR(sanitizeInstructionModel(model), sanitizeOptions(options));
}

export function irFor(model, options = {}) {
  return legacyIrFor(sanitizeInstructionModel(model), sanitizeOptions(options));
}
