import assert from 'node:assert/strict';
import { dynamicSymbolFileCapacity } from '../js/binary/elf-dynamic.js';

// Issue #4204: dynamicSymbolFileCapacity must treat DT_SYMTAB_SHNDX as a
// SYMTAB end candidate. Without it, the SHN_XINDEX companion table (and any
// bytes after it) sits inside the estimated Dynsym byte capacity and gets
// decoded as fake Elf*_Sym records.

const segment = { address: 0x1000n, size: 0x1000n, fileOffset: 0n, fileSize: 0x1000n, perms: {} };
const image = { segments: [segment], sections: [], warnings: [], metadata: { machine: 62 } };
const other = { address: 0x9000n, size: 0x1000n, fileOffset: 0x1000n, fileSize: 0x1000n, perms: {} };

const capacity = (tags, symtabVa, syment = 24n, source = image) =>
  dynamicSymbolFileCapacity(null, source, tags, symtabVa, syment);

// 1. SYMTAB -> SYMTAB_SHNDX -> STRTAB layout: the companion boundary caps the
// byte capacity; the STRTAB end must not swallow the companion table bytes.
{
  const tags = new Map([[6n, [0x1000n]], [34n, [0x1018n]], [5n, [0x1030n]]]);
  assert.equal(capacity(tags, 0x1000n), 1, 'DT_SYMTAB_SHNDX must bound the Dynsym file capacity');
}

// 2. Normal adjacent SYMTAB -> STRTAB layout keeps the existing estimate.
{
  const tags = new Map([[6n, [0x1000n]], [5n, [0x1048n]]]);
  assert.equal(capacity(tags, 0x1000n), 3, 'layout without a companion table is unchanged');
}

// 3. A companion VA before the SYMTAB must not shrink or negate the capacity.
{
  const tags = new Map([[6n, [0x1020n]], [34n, [0x1008n]], [5n, [0x1068n]]]);
  assert.equal(capacity(tags, 0x1020n), 3, 'a pre-SYMTAB companion must not be used as the end boundary');
}

// 4. A companion in another segment must not bound this segment's capacity.
{
  const tags = new Map([[6n, [0x1000n]], [34n, [0x9008n]], [5n, [0x1048n]]]);
  assert.equal(capacity(tags, 0x1000n), 3, 'a cross-segment companion is not a boundary');
  assert.equal(capacity(tags, 0x1000n, 24n, { ...image, segments: [segment, other] }), 3,
    'a companion mapped by another segment must not bound the SYMTAB segment');
}

// 5. Multiple companion entries: the nearest one after the SYMTAB wins.
{
  const tags = new Map([[6n, [0x1000n]], [34n, [0x1058n, 0x1030n]], [5n, [0x1080n]]]);
  assert.equal(capacity(tags, 0x1000n), 2, 'the nearest post-SYMTAB companion pointer is the boundary');
}

// 6. An unmapped companion pointer keeps the existing mapped-range policy.
{
  const tags = new Map([[6n, [0x1000n]], [34n, [0x800000n]], [5n, [0x1048n]]]);
  assert.equal(capacity(tags, 0x1000n), 3, 'an unmapped companion pointer must not affect capacity');
}

// 7. A companion that equals the SYMTAB pointer is not an end boundary.
{
  const tags = new Map([[6n, [0x1000n]], [34n, [0x1000n]], [5n, [0x1048n]]]);
  assert.equal(capacity(tags, 0x1000n), 3, 'a companion aliasing DT_SYMTAB must not zero the capacity');
}

console.log('issue-4204-pt-dynamic-symtab-shndx-capacity: PASS');
