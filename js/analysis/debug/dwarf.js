/**
 * Public DWARF provider boundary.
 *
 * Parsing/record construction remains in dwarf-core.js; this module owns the
 * strict paging contract so malformed caller cursors never reach JS coercion.
 */
export * from './dwarf-core.js';

import { assertDebugPageCursor } from './boundary.js';
import { DwarfDebugInfoProvider as CoreDwarfDebugInfoProvider } from './dwarf-core.js';

export class DwarfDebugInfoProvider extends CoreDwarfDebugInfoProvider {
  symbols(result, options = {}) {
    assertDebugPageCursor(options?.cursor);
    return super.symbols(result, options);
  }

  types(result, options = {}) {
    assertDebugPageCursor(options?.cursor);
    return super.types(result, options);
  }
}
