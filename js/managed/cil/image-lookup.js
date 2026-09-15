// Row lookups over an already-parsed managed image (#8791). Decoding N methods
// used to rescan the MethodDef/Field/Type row arrays once per method (and once
// more per call or static-field instruction), which turned method count into a
// multiplier for per-method work. A parsed image is immutable, so each
// projection is built lazily once per image object.
//
// Each map/set is keyed exactly the way the scan it replaces was keyed: raw row
// tokens for `.find(row => row.token === …)` sites, canonical token text for the
// `.some(row => cilTokenText(row.token) === …)` site. That keeps every
// unresolved/ambiguous outcome identical.
import { cilTokenText } from './metadata-layout.js';

const caches = new WeakMap();

function rowsOf(image, name) {
  const rows = image?.[name];
  return Array.isArray(rows) ? rows : null;
}

function buildLookups(methods, fields, types) {
  const methodByToken = new Map();
  const methodTokens = new Set();
  const initializersByOwner = new Map();
  const fieldByToken = new Map();
  const typeByToken = new Map();
  if (methods !== null) {
    for (const row of methods) {
      const token = row?.token;
      if (token != null && !methodByToken.has(token)) methodByToken.set(token, row);
      const text = cilTokenText(token);
      if (text !== null) methodTokens.add(text);
      if (row?.name === '.cctor' && row?.declaringTypeToken != null) {
        const declared = initializersByOwner.get(row.declaringTypeToken);
        if (declared === undefined) initializersByOwner.set(row.declaringTypeToken, [row]);
        else declared.push(row);
      }
    }
  }
  if (fields !== null) {
    for (const row of fields) {
      const token = row?.token;
      if (token != null && !fieldByToken.has(token)) fieldByToken.set(token, row);
    }
  }
  if (types !== null) {
    for (const row of types) {
      const token = row?.token;
      if (token != null && !typeByToken.has(token)) typeByToken.set(token, row);
    }
  }
  return Object.freeze({
    // The array identities this projection was derived from: a hand-built image
    // whose row arrays were swapped must never be served a stale lookup.
    methods,
    fields,
    types,
    hasMethodRows: methods !== null,
    methodByToken,
    methodTokens,
    initializersByOwner,
    fieldByToken,
    typeByToken,
  });
}

export function cilImageLookups(cilImage) {
  const methods = rowsOf(cilImage, 'methods');
  const fields = rowsOf(cilImage, 'fields');
  const types = rowsOf(cilImage, 'types');
  const cacheable = cilImage !== null && typeof cilImage === 'object';
  if (!cacheable) return buildLookups(methods, fields, types);
  const cached = caches.get(cilImage);
  if (cached !== undefined && cached.methods === methods
      && cached.fields === fields && cached.types === types) return cached;
  const lookups = buildLookups(methods, fields, types);
  caches.set(cilImage, lookups);
  return lookups;
}
