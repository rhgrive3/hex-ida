/**
 * Public Phase 8 transaction facade.
 *
 * The canonical state, atomic commit, private overlay, and C4-04 admission
 * implementation lives in transaction-core.js. Re-exporting the exact core
 * object keeps every caller on one write point while retaining the historical
 * transaction.js import path.
 */
export * from './transaction-core.js';
