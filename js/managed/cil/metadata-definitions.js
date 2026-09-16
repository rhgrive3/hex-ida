import {
  readCilDefinitions as readCilDefinitionsCore,
  bindCilMetadataTables,
} from './metadata-definitions-core.js';

export { bindCilMetadataTables };

// TypeSpec rows bypass the shared readRows() helper in the core decoder, so
// reserve their retained row objects before the core can allocate its Array.
// All other decoded tables remain charged by readRows() exactly once (#8704).
export function readCilDefinitions(bytes, view, layout, stringsStream, blobStream = null, guidStream = null, admission = null) {
  const typeSpecCount = layout?.rowCounts?.[0x1b] ?? 0;
  if (typeSpecCount) admission?.chargeObjects(typeSpecCount);
  return readCilDefinitionsCore(bytes, view, layout, stringsStream, blobStream, guidStream, admission);
}
