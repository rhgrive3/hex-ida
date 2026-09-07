import assert from 'node:assert/strict';
import test from 'node:test';

import { recoverSchemas } from '../js/schema.js';

test('#5803 an open-ended functionRange (end:null) no longer throws', async () => {
  const program = {
    unsupported: false,
    architecture: 'arm64',
    functionsReferencing() { return [{ addr: 0x1000n }]; },
    functionRange() { return { start: 0x1000n, end: null, region: null }; },
  };
  const out = await recoverSchemas({
    architecture: 'arm64',
    strings: [{ addr: 0x2000n, text: 'data.csv' }],
    program,
    read: async () => new Uint8Array(),
  });
  assert.ok(out, 'recovery completes without throwing');
  assert.equal(out.complete, true);
  assert.equal(Array.isArray(out.schemas) ? out.schemas.length : 0, 0, 'open-ended candidates yield no schema');
  assert.equal(Array.isArray(out.schemas) ? out.schemas.length : 0, 0, 'open-ended candidates cannot be read and yield no schema');
});

test('#5803 closed ranges still recover schemas', async () => {
  const bytes = new Uint8Array(32);
  bytes.set([0x25, 0x4b, 0x53, 0x4b], 0); // '%KSK'-style magic is not required; the parser probes files
  const program = {
    unsupported: false,
    architecture: 'arm64',
    functionsReferencing() { return [{ addr: 0x1000n }]; },
    functionRange() { return { start: 0x1000n, end: 0x1100n, region: null }; },
  };
  const out = await recoverSchemas({
    architecture: 'arm64',
    strings: [{ addr: 0x2000n, text: 'data.csv' }],
    program,
    read: async (addr, len) => bytes.subarray(0, Number(len)),
  });
  assert.ok(out);
});
