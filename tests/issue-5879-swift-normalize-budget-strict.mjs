import assert from 'node:assert/strict';
import test from 'node:test';

import { readSwiftMangledName, parseSwiftFieldDescriptorScan, parseSwiftFieldDescriptor } from '../js/swift.js';

function descriptorBytes({ recordSize = 12, count = 0, records = [] } = {}) {
  const header = new Uint8Array(16);
  const view = new DataView(header.buffer);
  view.setUint16(10, recordSize, true);
  view.setUint32(12, count, true);
  return { header, records };
}

const baseOptions = { compilerMetadata: true };

test('#5879 readSwiftMangledName coerces no structured maxBytes into a real budget', async () => {
  const bytes = new TextEncoder().encode('$s1A\0');
  const read = async (_addr, len) => bytes.subarray(0, len);
  const normal = await readSwiftMangledName(read, 0x1000n, { compilerMetadata: true });
  const malformed = await readSwiftMangledName(read, 0x1000n, { compilerMetadata: true, maxBytes: true });
  assert.equal(normal.complete, true);
  assert.deepEqual(malformed, normal, 'non-number maxBytes must fall back to the default budget, not Number(true)=1');
  const arrayMax = await readSwiftMangledName(read, 0x1000n, { compilerMetadata: true, maxBytes: ['4'] });
  assert.deepEqual(arrayMax, normal, 'array maxBytes must not coerce through Number()');
});

test('#5879 valid numeric budgets keep floor/clamp semantics', async () => {
  const bytes = new TextEncoder().encode('$s1A\0');
  const read = async (_addr, len) => bytes.subarray(0, Math.min(len, 2));
  const short = await readSwiftMangledName(read, 0x1000n, { compilerMetadata: true, maxBytes: 2.9 });
  assert.equal(short.complete, false, '2.9 floors to 2, truncating the name before NUL');
});
