import { parseMetadataAutoAsync, MAX_IL2CPP_METADATA_BYTES } from './il2cpp.js';

function declaredSize(file) {
  const size = file?.size ?? file?.byteLength;
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.t !== 'parse' || message.id == null) return;
  try {
    const file = message.file;
    if (!file || typeof file.arrayBuffer !== 'function') throw new Error('IL2CPP metadata file is unavailable.');
    // Pre-admission resource boundary (#8782): the parser's 64 MiB input budget
    // only ran *after* this worker materialized the whole user-selected file, so
    // a File that already declared an oversize length could exhaust the worker
    // heap before any bounded resource-limit error could be returned. Reject
    // provably oversize declared sizes without invoking arrayBuffer() at all;
    // the error keeps the parser's IL2CPP_METADATA_BUDGET class so callers see
    // the same bounded resource-limit code they would have from assertMetadataPreflight.
    const maxBytes = Number.isSafeInteger(message.maxInputBytes) && message.maxInputBytes > 0 ? message.maxInputBytes : MAX_IL2CPP_METADATA_BYTES;
    const size = declaredSize(file);
    if (size != null && size > maxBytes) {
      const error = new Error(`global-metadata.dat is too large (${size} bytes).`);
      error.code = 'IL2CPP_METADATA_BUDGET';
      throw error;
    }
    const buffer = await file.arrayBuffer();
    const result = await parseMetadataAutoAsync(buffer, { yield:true });
    self.postMessage({ id:message.id, ok:true, result });
  } catch (error) {
    self.postMessage({
      id:message.id,
      ok:false,
      error:{ name:error?.name || 'Error', code:error?.code || null, message:error?.message || String(error) },
    });
  }
};
