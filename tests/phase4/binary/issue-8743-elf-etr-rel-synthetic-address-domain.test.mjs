import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/elf.js';

// #8743 — [CRITICAL][ELF/ET_REL] a ~256-byte NOBITS object must not fabricate
// canonical VAs above the 64-bit synthetic address domain.
//
// assignRelocatableSectionAddresses() advanced an unbounded BigInt cursor with
// `cursor += sec.size`, so a tiny SHT_NOBITS section carrying an enormous
// sh_size pushed a LATER section's base/end past 2^64-1 while the image was
// still reported complete and the out-of-domain address was exposed as ordinary
// BinaryImage mapping authority. A valid placement must be withheld and the
// image marked partial before any canonical mapping publication.

const SHT_NULL = 0;
const SHT_NOBITS = 8;
const ET_REL = 1;
const X86_64 = 62;

const DOMAIN = 1n << 64n; // 2^64; addresses must stay strictly below it

function build({ sec1Size, sec2Size }) {
  const sectionHeaderOffset = 0x200;
  const sectionCount = 3; // 0 = SHT_NULL sentinel, 1 = huge NOBITS, 2 = small NOBITS
  const bytes = new Uint8Array(sectionHeaderOffset + sectionCount * 64);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, ET_REL, true);
  view.setUint16(18, X86_64, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(40, BigInt(sectionHeaderOffset), true); // shoff
  view.setUint16(52, 64, true); // ehsize
  view.setUint16(54, 56, true); // phentsize
  view.setUint16(56, 0, true); // phnum
  view.setUint16(58, 64, true); // shentsize
  view.setUint16(60, sectionCount, true); // shnum
  view.setUint16(62, 0, true); // shstrndx = SHN_UNDEF (no section-name table)

  const writeSection = (index, { type, size, addralign = 1n }) => {
    const p = sectionHeaderOffset + index * 64;
    view.setUint32(p + 4, type, true);
    view.setBigUint64(p + 32, size, true); // sh_size
    view.setBigUint64(p + 48, addralign, true); // sh_addralign
  };
  writeSection(0, { type: SHT_NULL, size: 0n });
  writeSection(1, { type: SHT_NOBITS, size: sec1Size, addralign: 1n });
  writeSection(2, { type: SHT_NOBITS, size: sec2Size, addralign: 1n });
  return parseELF(bytes);
}

// Reproduction: the ~256-byte counterexample — one huge NOBITS followed by a
// normal 16-byte NOBITS.
{
  const image = build({ sec1Size: DOMAIN - 1n, sec2Size: 0x10n });
  assert.equal(image.metadata.elfMetadata.complete, false,
    'the out-of-domain synthetic layout must not be reported as complete');
  assert.ok(image.metadata.elfMetadata.reasons.includes('section-synthetic-address-domain:1'),
    `expected a deterministic domain reason, got ${JSON.stringify(image.metadata.elfMetadata.reasons)}`);
  // No published section address may escape the 64-bit domain.
  assert.ok(!image.sections.some((s) => s.address >= DOMAIN),
    'no canonical section may expose a synthetic address >= 2^64');
  // The fabricated high VA must not resolve to canonical mapping authority.
  const mapping = image.resolveVirtualMapping(DOMAIN + 0xffffn);
  assert.ok(!mapping || mapping.kind === 'none' || mapping.kind == null,
    `out-of-domain VA must fail closed, got ${JSON.stringify(mapping && mapping.kind)}`);
}

// Alignment rounding that crosses the domain boundary is handled identically.
{
  const image = build({ sec1Size: DOMAIN - 0x1000n, sec2Size: DOMAIN - 1n });
  assert.equal(image.metadata.elfMetadata.complete, false,
    'a rounding/extent crossing past 2^64 must be withheld');
  assert.ok(image.sections.every((s) => s.address < DOMAIN));
}

// Control: an ordinary in-domain ET_REL keeps full authority (no regression).
{
  const image = build({ sec1Size: 0x100n, sec2Size: 0x10n });
  assert.equal(image.metadata.elfMetadata.complete, true,
    'normal in-domain synthetic layout must remain complete');
  const sec1 = image.sections.find((s) => s.index === 1);
  const sec2 = image.sections.find((s) => s.index === 2);
  assert.ok(sec1 && sec2);
  assert.ok(sec2.address > sec1.address && sec2.address < DOMAIN,
    'sections stay ordered and inside the domain');
}

console.log('issue-8743 ELF ET_REL synthetic address-domain fail-closed regression: PASS');
