// Regression for #5058: ECMA-335 II.25.4 — a fat method header must begin on
// a 4-byte boundary (a tiny header may begin at any byte). A MethodDef RVA
// mapping to an unaligned file offset carried a structurally readable fat
// header and was published as a valid method body.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCil } from '../js/managed/cil/parser.js';
import { parseCil as parseCilBase } from '../js/managed/cil/parser-base.js';

function buildPeCliMethod({ methodOffset, header }) {
  const buf = new Uint8Array(0x900);
  const view = new DataView(buf.buffer);

  // One-section PE32 image: RVA 0x2000 maps to file offset 0x200.
  buf[0] = 0x4d; buf[1] = 0x5a;
  view.setUint32(0x3c, 0x80, true);
  buf.set([0x50, 0x45, 0, 0], 0x80);
  view.setUint16(0x86, 1, true);
  view.setUint16(0x94, 0xe0, true);
  const optionalOffset = 0x98;
  view.setUint16(optionalOffset, 0x10b, true);
  view.setUint32(optionalOffset + 92, 16, true);
  view.setUint32(optionalOffset + 96 + 14 * 8, 0x2000, true);
  view.setUint32(optionalOffset + 96 + 14 * 8 + 4, 72, true);
  const sectionOffset = optionalOffset + 0xe0;
  view.setUint32(sectionOffset + 8, 0x700, true);
  view.setUint32(sectionOffset + 12, 0x2000, true);
  view.setUint32(sectionOffset + 16, 0x700, true);
  view.setUint32(sectionOffset + 20, 0x200, true);

  const cliOffset = 0x200;
  view.setUint32(cliOffset, 72, true);
  view.setUint32(cliOffset + 8, 0x2100, true);
  view.setUint32(cliOffset + 12, 0x200, true);

  const metadataOffset = 0x300;
  view.setUint32(metadataOffset, 0x424a5342, true);
  view.setUint16(metadataOffset + 4, 1, true);
  view.setUint16(metadataOffset + 6, 1, true);
  const version = new TextEncoder().encode('v4.0.30319\0\0');
  view.setUint32(metadataOffset + 12, version.length, true);
  buf.set(version, metadataOffset + 16);
  const flagsOffset = (metadataOffset + 16 + version.length + 3) & ~3;
  view.setUint16(flagsOffset + 2, 1, true);
  let streamPos = flagsOffset + 4;
  view.setUint32(streamPos, 0x80, true);
  view.setUint32(streamPos + 4, 0x80, true);
  streamPos += 8;
  buf.set(new TextEncoder().encode('#~\0'), streamPos);

  const tablesOffset = metadataOffset + 0x80;
  const valid = (1n << 2n) | (1n << 6n); // TypeDef + MethodDef (#7301 owner rule)
  view.setUint32(tablesOffset + 8, Number(valid & 0xffffffffn), true);
  view.setUint32(tablesOffset + 12, Number(valid >> 32n), true);
  let tablePos = tablesOffset + 24;
  view.setUint32(tablePos, 1, true);
  tablePos += 4;
  view.setUint32(tablePos, 1, true);
  tablePos += 4;
  view.setUint32(tablePos, 0, true); tablePos += 4; // TypeDef flags
  view.setUint16(tablePos, 0, true); tablePos += 2; // Name
  view.setUint16(tablePos, 0, true); tablePos += 2; // Namespace
  view.setUint16(tablePos, 0, true); tablePos += 2; // Extends
  view.setUint16(tablePos, 1, true); tablePos += 2; // FieldList
  view.setUint16(tablePos, 1, true); tablePos += 2; // MethodList
  view.setUint32(tablePos, 0x2000 + (methodOffset - 0x200), true); // MethodDef RVA

  if (header === 'fat') {
    view.setUint16(methodOffset, 0x3003, true);
    view.setUint16(methodOffset + 2, 8, true);
    view.setUint32(methodOffset + 4, 1, true);
    view.setUint32(methodOffset + 8, 0, true);
    buf[methodOffset + 12] = 0x2a;
  } else {
    buf[methodOffset] = (1 << 2) | 0x02;
    buf[methodOffset + 1] = 0x2a;
  }
  return buf;
}

test('#5058 fat method header at 1/2/3 mod 4 fails closed through the MethodDef RVA path', () => {
  for (const delta of [1, 2, 3]) {
    const bytes = buildPeCliMethod({ methodOffset: 0x500 + delta, header: 'fat' });
    assert.equal((0x500 + delta) % 4, delta % 4);
    assert.throws(
      () => parseCilBase(bytes, { binaryId: `unaligned-fat-5058-${delta}` }),
      /cil-fat-method-header-unaligned/,
      `fat header at offset ${0x500 + delta} (${delta} mod 4) must fail closed`,
    );
    assert.throws(
      () => parseCil(bytes, { binaryId: `unaligned-fat-5058-e2e-${delta}` }),
      /cil-unsupported-binary/,
      `an unaligned fat header must never be promoted through the public parseCil boundary`,
    );
  }
});

test('#5058 4-byte aligned fat method body still parses', () => {
  const image = parseCil(buildPeCliMethod({ methodOffset: 0x500, header: 'fat' }), { binaryId: 'aligned-fat-5058' });
  assert.equal(image.methodBodies.length, 1);
  assert.equal(image.methodBodies[0].isTiny, false);
  assert.equal(image.methodBodies[0].headerOffset, 0x500);
  assert.equal(image.methodBodies[0].codeSize, 1);
});

test('#5058 unaligned tiny method body remains legal', () => {
  for (const delta of [1, 2, 3]) {
    const image = parseCil(buildPeCliMethod({ methodOffset: 0x500 + delta, header: 'tiny' }), { binaryId: `unaligned-tiny-5058-${delta}` });
    assert.equal(image.methodBodies.length, 1);
    assert.equal(image.methodBodies[0].isTiny, true, `tiny header at offset ${0x500 + delta} must stay valid`);
  }
});
