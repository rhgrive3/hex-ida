// #8699: one exact #Strings interning authority per parse.
// A shared #Strings heap offset can be referenced by many TypeDef/Field/Method
// names, GenericParam names, and manifest/security rows. Each unique offset is
// scanned, charged against the parse's admission, and decoded exactly once;
// later references — from any reader — reuse the retained string instead of
// re-decoding (and re-charging) it. Admission is keyed to the parse-scoped
// #Strings stream object, so unrelated images/heap views keep separate caches.
// A string first decoded through a non-charging reader is still charged once
// the first charging reader references it, so interning can never launder a
// charge that the per-reference path would have made.
const caches = new WeakMap();

export function internCilStrings(stringsStream) {
  let cache = caches.get(stringsStream);
  if (!cache) {
    cache = new Map();
    caches.set(stringsStream, cache);
  }
  return cache;
}

export function readInternedCilHeapString(bytes, stringsStream, admission, value, decoder) {
  const cache = internCilStrings(stringsStream);
  const hit = cache.get(value);
  if (hit !== undefined) {
    if (hit.charged === false && admission) {
      admission.chargeStringBytes(hit.lengthBytes);
      hit.charged = true;
    }
    return hit.text;
  }
  const start = stringsStream.offset + value, end = stringsStream.offset + stringsStream.size;
  let pos = start;
  while (pos < end && bytes[pos] !== 0) pos++;
  if (pos === end) throw new TypeError('cil-definition-string-unterminated');
  const lengthBytes = pos - start;
  if (admission) admission.chargeStringBytes(lengthBytes);
  let text;
  try { text = decoder.decode(bytes.subarray(start, pos)); }
  catch { throw new TypeError('cil-invalid-strings-utf8'); }
  cache.set(value, { text, lengthBytes, charged: !!admission });
  return text;
}
