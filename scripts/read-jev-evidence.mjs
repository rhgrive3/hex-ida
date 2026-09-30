import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';

// Compression is packaging only. Consumers hash and verify the exact retained
// uncompressed bytes; missing artifacts never become empty passing evidence.
export function readJevEvidence(file,encoding) {
  const bytes=fs.existsSync(file)?fs.readFileSync(file):gunzipSync(fs.readFileSync(file instanceof URL?new URL(`${file.href}.gz`):`${file}.gz`));
  return encoding?bytes.toString(encoding):bytes;
}
