import assert from 'node:assert/strict';

import { elfSectionFileSpanConsistentWithLoads } from '../../../js/binary/elf-mapping.js';

const sectionAddress = 0x400000n;
const sectionSize = 0x100n;
const sectionOffset = 0x1000n;

function load({ address = 0x400000n, fileOffset = 0x1000n, fileSize = 0x1000n, size = fileSize } = {}) {
  return { address, fileOffset, fileSize, size };
}

function consistent(segments) {
  return elfSectionFileSpanConsistentWithLoads(
    { segments },
    sectionAddress,
    sectionSize,
    sectionOffset,
    false,
  );
}

// Two overlapping PT_LOAD owners with the same VA→file relation are
// unambiguous and remain authoritative regardless of program-header order.
{
  const a = load();
  const b = load();
  assert.equal(consistent([a, b]), true);
  assert.equal(consistent([b, a]), true);
}

// Regression for the R2 blocker: A covers the whole section and agrees, while
// B covers the same VA with a conflicting file offset. The old cursor loop
// returned true after A and never validated B. Every intersecting owner must be
// checked, and the result must not depend on PT_LOAD order.
{
  const agreeing = load();
  const conflicting = load({ fileOffset:0x2000n });
  assert.equal(consistent([agreeing, conflicting]), false);
  assert.equal(consistent([conflicting, agreeing]), false);
}

// A conflicting owner that intersects only a suffix must also fail closed even
// when another PT_LOAD already covers the entire section.
{
  const full = load();
  const conflictingSuffix = load({
    address:0x400080n,
    fileOffset:0x3000n,
    fileSize:0x80n,
  });
  assert.equal(consistent([full, conflictingSuffix]), false);
  assert.equal(consistent([conflictingSuffix, full]), false);
}

// Overlapping owners that describe the same relation at different starts are
// accepted, proving the check compares each intersection at its own boundary.
{
  const full = load();
  const agreeingSuffix = load({
    address:0x400080n,
    fileOffset:0x1080n,
    fileSize:0x80n,
  });
  assert.equal(consistent([full, agreeingSuffix]), true);
  assert.equal(consistent([agreeingSuffix, full]), true);
}

// Relation agreement is separate from coverage: a gap in the file-backed
// PT_LOAD union still prevents section-header file bytes from becoming runtime
// authority.
{
  const left = load({ fileSize:0x40n });
  const right = load({ address:0x400080n, fileOffset:0x1080n, fileSize:0x80n });
  assert.equal(consistent([left, right]), false);
}

console.log('issue-7611 overlapping PT_LOAD authority: PASS');
