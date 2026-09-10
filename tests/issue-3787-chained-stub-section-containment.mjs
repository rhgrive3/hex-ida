import assert from 'node:assert/strict';
import { __chainedInternalsForTests } from '../js/chained.js';

const { stubSectionWithinSegment } = __chainedInternalsForTests;
const segment = {
  vmaddr:0x1000n, vmsize:0x100n,
  fileoff:0x200n, filesize:0x100n,
  validFileRange:true,
};

assert.equal(stubSectionWithinSegment(segment, 0x1000n, 0xcn, 0x200n), true);
assert.equal(stubSectionWithinSegment(segment, 0x10f4n, 0xcn, 0x2f4n), true, 'exact parent end is allowed');
assert.equal(stubSectionWithinSegment(segment, 0x90000000n, 0xcn, 0x200n), false, 'VM escape is rejected');
assert.equal(stubSectionWithinSegment(segment, 0x1000n, 0xcn, 0x500n), false, 'file escape is rejected even if slice may contain it');
assert.equal(stubSectionWithinSegment(segment, 0x10f5n, 0xcn, 0x2f4n), false, 'VM end one byte beyond parent is rejected');
assert.equal(stubSectionWithinSegment(segment, 0x10f4n, 0xcn, 0x2f5n), false, 'file end one byte beyond parent is rejected');
assert.equal(stubSectionWithinSegment({ ...segment, validFileRange:false }, 0x1000n, 0xcn, 0x200n), false);

console.log('issue-3787 chained stub section containment: PASS');
