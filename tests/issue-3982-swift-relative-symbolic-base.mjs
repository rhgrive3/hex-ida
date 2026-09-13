import assert from 'node:assert/strict';
import { readSwiftMangledName } from '../js/swift.js';

function constantReader(bytes) {
  return async () => Uint8Array.from(bytes);
}

{
  const bytes = Uint8Array.from([0x01, 0x1f, 0x00, 0x00, 0x00, 0x79, 0x00]);
  const r = await readSwiftMangledName(constantReader(bytes), 0x1000n, { compilerMetadata: true, maxBytes: bytes.length });
  assert.equal(r.complete, true);
  assert.equal(r.symbolicReferences.length, 1);
  const ref = r.symbolicReferences[0];
  assert.equal(ref.relative, true);
  assert.equal(ref.address, 0x1000n, 'the reference record keeps the control-byte site address');
  assert.equal(ref.candidateTarget, 0x1020n, 'relative base must be the 4-byte payload address (control byte + 1), not the control byte');
}

{
  const bytes = Uint8Array.from([0x02, 0x00, 0xff, 0xff, 0xff, 0x61, 0x00]);
  const r = await readSwiftMangledName(constantReader(bytes), 0x1000n, { compilerMetadata: true, maxBytes: bytes.length });
  assert.equal(r.complete, true);
  assert.equal(r.symbolicReferences[0].candidateTarget, 0x0f01n, 'negative relative offsets must also anchor at the payload address');
}

{
  for (const kind of [0x01, 0x04, 0x10, 0x17]) {
    const bytes = Uint8Array.from([kind, 0x10, 0x00, 0x00, 0x00, 0x7a, 0x00]);
    const r = await readSwiftMangledName(constantReader(bytes), 0x2000n, { compilerMetadata: true, maxBytes: bytes.length });
    assert.equal(r.symbolicReferences[0].candidateTarget, 0x2011n, `kind 0x${kind.toString(16)} must share the payload-base contract`);
  }
}

{
  const seen = [];
  const bytes = Uint8Array.from([0x03, 0x08, 0x00, 0x00, 0x00, 0x7b, 0x00]);
  await readSwiftMangledName(constantReader(bytes), 0x1000n, {
    compilerMetadata: true,
    maxBytes: bytes.length,
    resolveSwiftSymbolicReference(ref) {
      seen.push(ref);
      return null;
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].candidateTarget, 0x1009n, 'resolver must receive a payload-base candidateTarget');
}

{
  const bytes = Uint8Array.from([0x18, 0x00, 0x20, 0x00, 0x00, 0x79, 0x00]);
  const r = await readSwiftMangledName(constantReader(bytes), 0x1000n, { compilerMetadata: true, maxBytes: bytes.length, pointerBytes: 4 });
  assert.equal(r.symbolicReferences[0].rawTarget, 0x2000n, 'absolute symbolic references must stay untouched');
  assert.equal(r.symbolicReferences[0].candidateTarget, null);
}

{
  const bytes = Uint8Array.from([0x01, 0x20, 0x00]);
  const r = await readSwiftMangledName(constantReader(bytes), 0x0n, { compilerMetadata: true, maxBytes: bytes.length });
  assert.equal(r.complete, false);
  assert.equal(r.reason, 'symbolic-reference-truncated');
}

console.log('issue-3982 Swift relative symbolic reference base: ok');
