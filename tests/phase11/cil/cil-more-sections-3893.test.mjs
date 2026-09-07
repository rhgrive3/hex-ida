import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCil } from '../../../js/managed/cil/parser.js';

const METHOD_OFFSET = 0x500;
const CODE_SIZE = 16;
const CODE_OFFSET = METHOD_OFFSET + 12;
const FIRST_SECTION_OFFSET = (CODE_OFFSET + CODE_SIZE + 3) & ~3;

function writeFatEhSection(bytes, offset, { more = false, token = 0x01000001, clauseIndex = 0 } = {}) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dataSize = 28;
  bytes[offset] = 0x41 | (more ? 0x80 : 0); // EHTable | FatFormat | MoreSects
  bytes[offset + 1] = dataSize;
  bytes[offset + 2] = 0;
  bytes[offset + 3] = 0;

  const clauseOffset = offset + 4;
  const tryOffset = (clauseIndex % 2) * 4;
  const handlerOffset = 8 + (clauseIndex % 2) * 4;
  view.setUint32(clauseOffset, 0, true); // catch
  view.setUint32(clauseOffset + 4, tryOffset, true);
  view.setUint32(clauseOffset + 8, 4, true);
  view.setUint32(clauseOffset + 12, handlerOffset, true);
  view.setUint32(clauseOffset + 16, 4, true);
  view.setUint32(clauseOffset + 20, token, true);
  return (offset + dataSize + 3) & ~3;
}

function buildCil({
  sectionCount = 1,
  terminalAfter = sectionCount,
  truncateAfterFirst = false,
  unknownKind = false,
  zeroDataSize = false,
  smallReservedNonzero = false,
} = {}) {
  const fullLength = Math.max(0x900, FIRST_SECTION_OFFSET + sectionCount * 32 + 0x100);
  const firstSectionEnd = FIRST_SECTION_OFFSET + 28;
  const bytes = new Uint8Array(truncateAfterFirst ? firstSectionEnd : fullLength);
  const view = new DataView(bytes.buffer);

  // One-section PE32 image. RVA 0x2000 maps to file offset 0x200.
  bytes[0] = 0x4d; bytes[1] = 0x5a;
  view.setUint32(0x3c, 0x80, true);
  bytes.set([0x50, 0x45, 0, 0], 0x80);
  view.setUint16(0x86, 1, true);
  view.setUint16(0x94, 0xe0, true);
  const optionalOffset = 0x98;
  view.setUint16(optionalOffset, 0x10b, true);
  view.setUint32(optionalOffset + 92, 16, true);
  view.setUint32(optionalOffset + 96 + 14 * 8, 0x2000, true);
  view.setUint32(optionalOffset + 96 + 14 * 8 + 4, 72, true);

  const sectionOffset = optionalOffset + 0xe0;
  const rawSize = bytes.length - 0x200;
  view.setUint32(sectionOffset + 8, rawSize, true);
  view.setUint32(sectionOffset + 12, 0x2000, true);
  view.setUint32(sectionOffset + 16, rawSize, true);
  view.setUint32(sectionOffset + 20, 0x200, true);

  const cliOffset = 0x200;
  view.setUint32(cliOffset, 72, true);
  view.setUint32(cliOffset + 8, 0x2100, true);
  view.setUint32(cliOffset + 12, 0x180, true);

  // Metadata root with a single #~ stream containing one MethodDef row.
  const metadataOffset = 0x300;
  view.setUint32(metadataOffset, 0x424a5342, true);
  view.setUint16(metadataOffset + 4, 1, true);
  view.setUint16(metadataOffset + 6, 1, true);
  const version = new TextEncoder().encode('v4.0.30319\0\0');
  view.setUint32(metadataOffset + 12, version.length, true);
  bytes.set(version, metadataOffset + 16);
  const flagsOffset = (metadataOffset + 16 + version.length + 3) & ~3;
  view.setUint16(flagsOffset + 2, 1, true);
  let streamPos = flagsOffset + 4;
  view.setUint32(streamPos, 0x80, true);
  view.setUint32(streamPos + 4, 0x60, true);
  streamPos += 8;
  bytes.set(new TextEncoder().encode('#~\0'), streamPos);

  const tablesOffset = metadataOffset + 0x80;
  view.setUint32(tablesOffset + 8, 1 << 6, true);
  let tablePos = tablesOffset + 24;
  view.setUint32(tablePos, 1, true);
  tablePos += 4;
  view.setUint32(tablePos, 0x2300, true); // MethodDef RVA -> file 0x500

  // Fat method header with CorILMethod_MoreSects and a valid 16-byte body.
  view.setUint16(METHOD_OFFSET, 0x300b, true);
  view.setUint16(METHOD_OFFSET + 2, 8, true);
  view.setUint32(METHOD_OFFSET + 4, CODE_SIZE, true);
  view.setUint32(METHOD_OFFSET + 8, 0, true);
  bytes.fill(0, CODE_OFFSET, CODE_OFFSET + CODE_SIZE);
  bytes[CODE_OFFSET + CODE_SIZE - 1] = 0x2a; // ret

  if (unknownKind) {
    bytes[FIRST_SECTION_OFFSET] = 0x02; // unsupported method-data section kind
    bytes[FIRST_SECTION_OFFSET + 1] = 4;
    return bytes;
  }

  if (zeroDataSize) {
    bytes[FIRST_SECTION_OFFSET] = 0x41 | 0x80; // EHTable | FatFormat | MoreSects
    bytes[FIRST_SECTION_OFFSET + 1] = 0;
    bytes[FIRST_SECTION_OFFSET + 2] = 0;
    bytes[FIRST_SECTION_OFFSET + 3] = 0;
    return bytes;
  }

  if (smallReservedNonzero) {
    bytes[FIRST_SECTION_OFFSET] = 0x01; // EHTable | SmallFormat
    bytes[FIRST_SECTION_OFFSET + 1] = 16;
    bytes[FIRST_SECTION_OFFSET + 2] = 1; // nonzero reserved byte
    bytes[FIRST_SECTION_OFFSET + 3] = 0;
    return bytes;
  }

  let extraOffset = FIRST_SECTION_OFFSET;
  for (let index = 0; index < sectionCount; index++) {
    const more = index + 1 < terminalAfter;
    extraOffset = writeFatEhSection(bytes, extraOffset, {
      more,
      token: 0x01000001 + index,
      clauseIndex: index,
    });
    if (truncateAfterFirst) break;
  }
  return bytes;
}

test('#3893 follows MoreSects across multiple EH sections', () => {
  for (const sectionCount of [2, 3]) {
    const parsed = parseCil(buildCil({ sectionCount }));
    assert.equal(parsed.methodBodies.length, 1);
    const clauses = parsed.methodBodies[0].exceptionClauses;
    assert.equal(clauses.length, sectionCount);
    assert.deepEqual(
      clauses.map((clause) => clause.classTokenOrFilter),
      Array.from({ length: sectionCount }, (_, index) => 0x01000001 + index),
    );
  }
});

test('#3893 terminal section stops the chain even when valid-looking data follows', () => {
  const parsed = parseCil(buildCil({ sectionCount: 2, terminalAfter: 1 }));
  assert.equal(parsed.methodBodies[0].exceptionClauses.length, 1);
});

test('#3893 truncated next section fails closed', () => {
  assert.throws(
    () => parseCil(buildCil({ sectionCount: 2, truncateAfterFirst: true })),
    /cil-method-extra-section-truncated/,
  );
});

test('#3893 unsupported method-data section kind does not silently look complete', () => {
  assert.throws(
    () => parseCil(buildCil({ unknownKind: true })),
    /cil-unsupported-method-extra-section/,
  );
});

test('#3893 zero dataSize fails closed', () => {
  assert.throws(
    () => parseCil(buildCil({ zeroDataSize: true })),
    /cil-invalid-method-extra-section/,
  );
});

test('#3893 small format nonzero reserved bytes fails closed', () => {
  assert.throws(
    () => parseCil(buildCil({ smallReservedNonzero: true })),
    /cil-invalid-method-extra-section/,
  );
});

test('#3893 chained sections exceeding budget fail closed', () => {
  assert.throws(
    () => parseCil(buildCil({ sectionCount: 65 })),
    /cil-method-extra-sections-exceeded/,
  );
});
