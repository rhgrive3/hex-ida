import assert from 'node:assert/strict';

import {
  APPLE_KNOWLEDGE_FORMAT_MATRIX,
  buildAppleKnowledge,
  parseDyldSharedCache,
} from '../../../js/apple/knowledge.js';
import { parseMachO } from '../../../js/binary/macho.js';

function cacheFixture(architecture = 'arm64e') {
  const bytes = new Uint8Array(104);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(`dyld_v1  ${architecture}`), 0);
  view.setUint32(16, 104, true);
  view.setUint32(20, 0, true);
  view.setBigUint64(32, 0x180000000n, true);
  return bytes;
}

const thin = new Uint8Array(32);
const header = new DataView(thin.buffer);
header.setUint32(0, 0xfeedfacf, true);
header.setUint32(4, 0x0100000c, true);
header.setUint32(8, 2, true);
header.setUint32(12, 1, true);
const image = parseMachO(thin);
const knowledge = buildAppleKnowledge({ image });

assert.equal(knowledge.identity.authoritative, true);
assert.equal(knowledge.cells.chainedFixups.status, 'absent');
assert.equal(knowledge.cells.pointerAuthentication.status, 'absent');
assert.equal(knowledge.cells.codeSigning.status, 'absent');
assert.equal(knowledge.cells.codeSigning.evidence.validity, 'unknown');
assert.deepEqual(APPLE_KNOWLEDGE_FORMAT_MATRIX.chainedFixups.authenticatedPointerFormats, [1, 7, 9, 10, 12]);

const cache = parseDyldSharedCache(cacheFixture());
assert.equal(cache.status, 'supported');
assert.equal(cache.header.dyldBaseAddress, 0x180000000n);
assert.equal(parseDyldSharedCache(cacheFixture('arm64x')).status, 'unsupported');

console.log('T036 Apple loader matrix boundary: PASS');
