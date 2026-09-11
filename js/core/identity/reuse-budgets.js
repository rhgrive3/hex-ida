/**
 * Disposable identity reuse budgets for the mobile/browser runtime.
 * These are per-module-instance (per realm), NOT application RSS limits.
 * Text weights count UTF-16 payload bytes; engine tables/objects add overhead.
 * Exceeding a budget discards only an optimization, never validation or output.
 * Keep one auditable policy instead of growing independent caches by accident.
 */
export const IDENTITY_REUSE_BUDGETS = Object.freeze({
  immutableMetadataEntries: 16384,
  frozenMetadataEntries: 8192,
  immutableDigest: Object.freeze({ entries: 4096, bytes: 256 * 1024 }),
  immutableJson: Object.freeze({ entries: 512, bytes: 256 * 1024, maxTextLength: 32 * 1024 }),
  frozenIdentityText: Object.freeze({ entries: 1024, bytes: 128 * 1024, maxTextLength: 4 * 1024 }),
  graphDigest: Object.freeze({ entries: 4096, bytes: 256 * 1024 }),
  // One identity request shares this allowance between shape and SSA encoding.
  passiveText: Object.freeze({ entries: 1024, bytes: 256 * 1024, maxEntryBytes: 16 * 1024 }),
  originTableNodes: 1024,
});
