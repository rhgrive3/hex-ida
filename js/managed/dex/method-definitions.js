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
// Do not cache a derived index on caller-owned mutable image objects.
export function dexMethodDefinitions(image) {
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
  return out;
}
