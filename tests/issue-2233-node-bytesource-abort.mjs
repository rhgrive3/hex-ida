import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeFileByteSource } from '../js/bytesource/node.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hex-node-bytesource-'));
const file = path.join(dir, 'abort.bin');
await fs.writeFile(file, Uint8Array.of(0x41, 0x42, 0x43));

const source = await NodeFileByteSource.open(file);
try {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => source.read(0n, 1, { signal: controller.signal }),
    (error) => error?.name === 'AbortError' && error?.code === 'ABORT_ERR',
  );
} finally {
  await source.close();
  await fs.rm(dir, { recursive: true, force: true });
}

console.log('issue-2233 NodeFileByteSource abort regression PASS');
