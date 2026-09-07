import assert from 'node:assert/strict';

// Execute the full Apple knowledge matrix as the owned T015 final-closure gate.
// The matrix contains resident parse positives plus forged, mismatched,
// cancelled, malformed, and unbound/UNKNOWN cases.
await import('../../apple-knowledge-x02.test.mjs');

import { machOImageAuthority, parseMachO } from '../../../js/binary/macho-core.js';

const bytes = new Uint8Array(32);
const view = new DataView(bytes.buffer);
view.setUint32(0, 0xfeedfacf, true);
view.setUint32(4, 0x0100000c, true);
view.setUint32(8, 2, true);
view.setUint32(12, 1, true);
const image = parseMachO(bytes);
const authority = machOImageAuthority(image);
assert.ok(authority, 'resident Mach-O parse must issue private authority');
assert.equal(authority.binaryIdentity.startsWith('bin_sha256_'), true);
assert.equal(authority.sliceIdentity.startsWith('slice_macho_'), true);
assert.equal(authority.contentMatches(), true);
assert.equal(machOImageAuthority({ ...image }), null, 'a copied public object cannot inherit parser authority');

console.log('T015 owned Apple knowledge gate: PASS');
