import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPackageEnvelope,
  importPhase12Package,
} from '../../../js/phase12/package-envelope.js';

function envelopeWithPayload(base, payload) {
  return { ...base, payload };
}

test('#5219 admitted snapshot survives downstream validation without re-reading a deep getter', () => {
  const base = createPackageEnvelope({ kind: 'knowledge', payload: { trap: 0 } });
  let reads = 0;
  const payload = {};
  Object.defineProperty(payload, 'trap', {
    enumerable: true,
    get() {
      reads += 1;
      if (reads === 1) return 0;
      let chain = { leaf: 1 };
      for (let i = 0; i < 50_000; i += 1) chain = { next: chain };
      return chain;
    },
  });

  const imported = importPhase12Package(envelopeWithPayload(base, payload), { maxDepth: 64 });
  assert.equal(imported.contentHash, base.contentHash);
  assert.deepEqual(imported.payload, { trap: 0 });
  assert.equal(reads, 1, 'downstream validation and identity must consume the admitted snapshot');
});

test('#5219 admitted snapshot survives downstream identity without re-reading a large binary getter', () => {
  const base = createPackageEnvelope({ kind: 'knowledge', payload: { blob: 0 } });
  let reads = 0;
  const payload = {};
  Object.defineProperty(payload, 'blob', {
    enumerable: true,
    get() {
      reads += 1;
      if (reads === 1) return 0;
      return new Uint8Array(500_000);
    },
  });

  const imported = importPhase12Package(envelopeWithPayload(base, payload), { maxBytes: 8192 });
  assert.equal(imported.contentHash, base.contentHash);
  assert.deepEqual(imported.payload, { blob: 0 });
  assert.equal(reads, 1, 'content identity must not re-read the caller object after admission');
});
