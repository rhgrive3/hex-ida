/** Shared local-only input adapter. Regular files only, no symlink/device/FIFO
 * traversal; cap the read even if the file grows between fstat and read. */
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
export async function readBoundedJson(path, { maxBytes, work } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 12 * 1024 * 1024 || !work) throw new TypeError('local-json-read-bound');
  work.checkpoint(); let file;
  const pending = open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    try { file = await work.await(() => pending); }
    catch (error) { void pending.then(handle => handle.close()).catch(() => {}); throw error; }
    const stat = await work.await(() => file.stat());
    if (!stat.isFile() || stat.size > maxBytes) throw new TypeError('portable-input-size-or-type');
    work.charge('residentBytes', maxBytes + 1);
    const bytes = Buffer.alloc(maxBytes + 1); let length = 0;
    while (length < bytes.length) {
      work.checkpoint();
      const part = await work.await(() => file.read(bytes, length, bytes.length - length, length));
      if (!part.bytesRead) break; length += part.bytesRead;
    }
    if (length > maxBytes) throw new TypeError('portable-input-size');
    work.charge('residentBytes', length * 2);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    work.checkpoint(); const result = JSON.parse(text); work.checkpoint(); return result;
  } finally {
    if (file) {
      let timer;
      try { await Promise.race([file.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('local-json-close-timeout')), 1000); })]); }
      finally { clearTimeout(timer); }
    }
  }
}
