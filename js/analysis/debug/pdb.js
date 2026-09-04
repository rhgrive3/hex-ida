/**
 * Public PDB provider boundary.
 *
 * Parsing/record construction remains in pdb-core.js; this module owns strict
 * paging and CodeView identity validation before authority can be established.
 */
export * from './pdb-core.js';

import { assertDebugPageCursor, normalizeCodeViewIdentity } from './boundary.js';
import { PdbDebugInfoProvider as CorePdbDebugInfoProvider } from './pdb-core.js';

function normalizeImageCodeView(image) {
  const codeView = image?.identity?.codeView ?? null;
  if (codeView == null) return image;
  const identity = image?.identity && typeof image.identity === 'object' && !Array.isArray(image.identity)
    ? image.identity
    : {};
  return {
    ...image,
    identity: { ...identity, codeView: normalizeCodeViewIdentity(codeView) },
  };
}

export class PdbDebugInfoProvider extends CorePdbDebugInfoProvider {
  probe(image, options = {}) {
    return super.probe(normalizeImageCodeView(image), options);
  }

  symbols(result, options = {}) {
    assertDebugPageCursor(options?.cursor);
    return super.symbols(result, options);
  }

  types(result, options = {}) {
    assertDebugPageCursor(options?.cursor);
    return super.types(result, options);
  }
}
