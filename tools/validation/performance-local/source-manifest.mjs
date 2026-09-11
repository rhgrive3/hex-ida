import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function sourceManifest(root) {
  const files = [];
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) files.push({ path: name, sha256: sha256(fs.readFileSync(path.join(root, name))) });
    }
  }
  walk('js'); walk('tools/validation/phase8');
  return { sha256: sha256(JSON.stringify(files)), files };
}
