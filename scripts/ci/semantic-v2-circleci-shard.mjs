import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const index = Number.parseInt(process.env.SHARD_INDEX || '', 10);
const total = Number.parseInt(process.env.SHARD_TOTAL || '', 10);
if (!Number.isInteger(index) || !Number.isInteger(total) || index < 0 || total < 1 || index >= total) {
  throw new Error(`invalid semantic-v2 shard ${process.env.SHARD_INDEX}/${process.env.SHARD_TOTAL}`);
}

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/semantic-v2');
const files = fs.readdirSync(directory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map((entry) => entry.name)
  .sort((a, b) => a.localeCompare(b));
const selected = files.filter((_, fileIndex) => fileIndex % total === index);
if (!selected.length) throw new Error(`semantic-v2 shard ${index}/${total} is empty`);
for (const file of selected) {
  process.stdout.write(`[semantic-v2 shard ${index}/${total}] ${file}\n`);
  await import(pathToFileURL(path.join(directory, file)).href);
}
console.log(`semantic-v2 shard ${index}/${total}: PASS (${selected.length} files)`);
