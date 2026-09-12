import { SORT_KIND } from '../expr/kinds.js';

function modelEntries(model) {
  if (model instanceof Map) return [...model.entries()];
  if (!model || typeof model !== 'object' || Array.isArray(model) || Object.getPrototypeOf(model) !== Object.prototype) return null;
  if (Reflect.ownKeys(model).some((key) => typeof key === 'symbol')) return null;
  const entries = [];
  for (const key of Reflect.ownKeys(model)) {
    const descriptor = Object.getOwnPropertyDescriptor(model, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
    entries.push([key, descriptor.value]);
  }
  return entries;
}

/** Validate exact witness shape before semantic evaluation or publication. */
export function validateExactModelBindings(symbols, model) {
  const entries = modelEntries(model);
  if (!entries) return Object.freeze({ valid: false, reason: 'invalid-exact-model-container' });
  const values = new Map(entries);
  if (values.size !== entries.length || entries.some(([key]) => typeof key !== 'string')) {
    return Object.freeze({ valid: false, reason: 'invalid-exact-model-key' });
  }
  const allowed = new Set(symbols.map((symbol) => symbol.symbolId));
  for (const key of values.keys()) {
    if (!allowed.has(key)) return Object.freeze({ valid: false, reason: `unexpected-exact-model-binding:${key}` });
  }
  for (const symbol of symbols) {
    if (!values.has(symbol.symbolId)) return Object.freeze({ valid: false, reason: `missing-exact-model-binding:${symbol.symbolId}` });
    const value = values.get(symbol.symbolId);
    if (symbol.sort.kind === SORT_KIND.BOOL) {
      if (typeof value !== 'boolean') return Object.freeze({ valid: false, reason: `noncanonical-bool-model-value:${symbol.symbolId}` });
    } else if (symbol.sort.kind === SORT_KIND.BV) {
      if (typeof value !== 'bigint' || value < 0n || value >= (1n << BigInt(symbol.sort.width))) {
        return Object.freeze({ valid: false, reason: `noncanonical-bv-model-value:${symbol.symbolId}` });
      }
    } else return Object.freeze({ valid: false, reason: `unsupported-model-sort:${symbol.symbolId}` });
  }
  return Object.freeze({ valid: true });
}
