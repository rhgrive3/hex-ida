import assert from 'node:assert/strict';

import { SwiftMetadataProvider } from '../../js/metadata/swift.js';

const swiftSection = Object.freeze({
  section: '__swift5_types',
  address: 0x1000n,
  size: 0x20,
});

// #3448: Swift sections are evidence that metadata is present. If the provider
// cannot read them, the result must remain incomplete/evidence-missing rather
// than being laundered into the same complete/absent state as a no-Swift binary.
{
  const provider = new SwiftMetadataProvider({
    sections: [swiftSection],
    readAt: null,
    binaryIdentity: 'binary-3448',
  });
  const result = await provider.probe();
  assert.equal(result.identity.verdict, 'identity-unavailable');
  assert.equal(result.completeness.present, true);
  assert.equal(result.completeness.complete, false);
  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.stopReason, 'evidence-missing');
  assert.deepEqual([...result.sections], ['__swift5_types']);
  assert.ok(result.diagnostics.some((item) => /no reader/i.test(item)));
}

// Truly absent Swift sections retain the existing complete/absent semantics.
{
  const provider = new SwiftMetadataProvider({
    sections: [{ section: '__text', address: 0x1000n, size: 0x20 }],
    readAt: null,
    binaryIdentity: 'binary-3448',
  });
  const result = await provider.probe();
  assert.equal(result.identity.verdict, 'identity-unavailable');
  assert.equal(result.completeness.present, false);
  assert.equal(result.completeness.complete, true);
  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.status.stopReason, null);
  assert.deepEqual([...result.sections], []);
}

console.log('Swift reader completeness regression #3448: PASS');
