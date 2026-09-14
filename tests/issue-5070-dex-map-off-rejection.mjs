import assert from 'node:assert/strict';
import { parseDex } from '../js/managed/dex/parser.js';
import { buildMinimalDex } from './phase11/dex/dex-parser.test.mjs';

{
  const bytes = buildMinimalDex();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(52, 0xfffffff0, true);
  assert.throws(
    () => parseDex(bytes),
    (error) => error instanceof TypeError && error.message === 'dex-invalid-map-offset',
  );
}

{
  const bytes = buildMinimalDex();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(52, bytes.length - 2, true);
  assert.throws(
    () => parseDex(bytes),
    (error) => error instanceof TypeError && error.message === 'dex-invalid-map-offset',
  );
}

{
  const bytes = buildMinimalDex();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(52, 0x21, true);
  assert.throws(() => parseDex(bytes), (error) => error.message === 'dex-invalid-map-offset');
}

console.log('issue-5070-dex-map-off-rejection: ok');
