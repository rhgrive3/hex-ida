import { parseMetadataAutoAsync } from './il2cpp.js';

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.t !== 'parse' || message.id == null) return;
  try {
    const file = message.file;
    if (!file || typeof file.arrayBuffer !== 'function') throw new Error('IL2CPP metadata file is unavailable.');
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
