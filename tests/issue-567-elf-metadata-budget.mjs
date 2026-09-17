import assert from 'node:assert/strict';
import { parseELF } from '../js/binary/elf.js';
import { makeElf64Fixture } from './universal-binary.mjs';

const image = parseELF(makeElf64Fixture(), {
  metadataLimits:{ records:1, objects:32, stringBytes:4096, inputBytes:1<<20, operations:100, estimatedHeapBytes:1<<20, wallClockMs:5000 },
});
assert.equal(image.metadata.elfMetadata.complete, false);
assert.ok(image.metadata.elfMetadata.reasons.some((reason) => reason.startsWith('budget:')));
assert.ok(image.symbols.length <= 1);
assert.ok(image.metadata.elfMetadata.used.records <= image.metadata.elfMetadata.limits.records);
console.log('issue #567 shared ELF metadata budget: PASS');
