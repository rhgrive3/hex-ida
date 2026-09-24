import { fail } from './validation-utils.js';

export function dexDefinitionCodeError(entry) {
  const flags = entry?.accessFlags, offset = entry?.codeOff;
  if (!Number.isSafeInteger(flags) || flags < 0 || flags > 0xffffffff
    || !Number.isSafeInteger(offset) || offset < 0 || offset > 0xffffffff) return 'dex-invalid-method-definition';
  const noBody = (flags & (0x0100 | 0x0400)) !== 0;
  if (noBody && offset !== 0) return 'dex-code-item-forbidden-for-native-or-abstract-method';
  if (!noBody && offset === 0) return 'dex-code-item-required-for-concrete-method';
  return null;
}

// method_ids is a reference table. Only class_data grants definition authority.
// Do not cache a derived index on caller-owned MUTABLE image objects. A parsed DEX
// image's methods/classes authority tables are deeply frozen by `parseDex`, so the
// derived definition authority can be reused (memoized out-of-band, keyed on the image
// in a WeakMap) instead of being rebuilt + full-scanned for every single method decode.
// Without this, `open()` -> `enumerateMethods()` -> `decodeMethod()` per method rebuilt
// the whole module authority + re-scanned classes, making ordinary whole-module decode
// O(N^2) on a valid DEX (#8976). The WeakMap never attaches to the image and is GC'd
// with it; only frozen images with deeply immutable definition authority tables are
// cached, so mutable caller data never returns a stale index.
const definitionIndexByFrozenImage = new WeakMap();

function isDeepFrozen(value, seen = new WeakSet()) {
  if (value == null || (typeof value !== 'object' && typeof value !== 'function')) return true;
  if (seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor && !isDeepFrozen(descriptor.value, seen)) return false;
  }
  return true;
}

export function dexMethodDefinitions(image) {
  const methods = image != null && typeof image === 'object'
    ? Object.getOwnPropertyDescriptor(image, 'methods') : null;
  const classes = image != null && typeof image === 'object'
    ? Object.getOwnPropertyDescriptor(image, 'classes') : null;
  const cacheable = image != null && typeof image === 'object' && Object.isFrozen(image)
    && methods && 'value' in methods && Array.isArray(methods.value) && isDeepFrozen(methods.value)
    && classes && 'value' in classes && Array.isArray(classes.value) && isDeepFrozen(classes.value);
  if (cacheable) {
    const cached = definitionIndexByFrozenImage.get(image);
    if (cached) return cached;
  }
  const out = new Map();
  for (const cls of image?.classes ?? []) {
    for (const kind of ['directMethods', 'virtualMethods']) {
      const entries = cls?.[kind] ?? [];
      if (!Array.isArray(entries)) fail('dex-invalid-method-definitions');
      for (const entry of entries) {
        const index = entry?.methodIdx;
        if (!Number.isSafeInteger(index) || index < 0 || !image.methods?.[index]) fail('dex-invalid-class-data-method-index');
        if (out.has(index)) fail('dex-duplicate-method-definition');
        const method = image.methods[index];
        if (cls.classType != null && cls.classType !== method.classType) fail('dex-method-definition-owner-mismatch');
        out.set(index, entry);
      }
    }
  }
  if (cacheable) definitionIndexByFrozenImage.set(image, out);
  return out;
}
