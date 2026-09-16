// Receiver-only decoder authority is intentionally kept in a module that has
// no dependency on effect helpers.  That lets semantic owners consult the
// private brand without creating a runtime-provenance/effects import cycle.
const RECEIVER_REVALIDATED_ROWS = new WeakSet();

export function registerReceiverRevalidatedX86Row(row) {
  if (row == null || (typeof row !== 'object' && typeof row !== 'function')) {
    throw new TypeError('x86-decoder-runtime-provenance-row-required');
  }
  RECEIVER_REVALIDATED_ROWS.add(row);
  return row;
}

export function hasReceiverRevalidatedX86Row(row) {
  return row != null
    && (typeof row === 'object' || typeof row === 'function')
    && RECEIVER_REVALIDATED_ROWS.has(row);
}
