import assert from 'node:assert/strict';
import test from 'node:test';

import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { buildCil, cilTables } from '../fixtures/medium-cil.mjs';

// Combined authority regression (#7601 × #7775): a signature-resolved MemberRef
// `newobj` must publish the owner's canonical constructed-type identity AND —
// when the CLI header flags make the image 32BITREQUIRED — the 32-bit
// native-width authority on the SAME produced value. The native-width
// re-application that replaced the signature-resolved stack effect must not
// evict the constructed-type identity, and the owner identity must not evict
// the width. AnyCPU keeps the owner without fabricating a width.

const align = (n) => Math.ceil(n / 4) * 4;
const pad = (b) => { const p = new Uint8Array(align(b.length)); p.set(b); return p; };
const utf8 = (s) => [...new TextEncoder().encode(s), 0];

// #Strings: [0]'A'[3]'N'[5]'Caller'[12]'.ctor'
const strings = [0, ...utf8('A'), ...utf8('N'), ...utf8('Caller'), ...utf8('.ctor')];
// #Blob: #1 @1 = instance void() ctor [0x20,0,1]; #2 @5 = static void() Caller [0,0,1]
const blob = Uint8Array.from([0, 0x03, 0x20, 0x00, 0x01, 0x03, 0x00, 0x00, 0x01, 0]);

const NEWOBJ_MEMBERREF = [0x73, 0x01, 0x00, 0x00, 0x0a, 0x26, 0x2a]; // newobj 0x0A000001; pop; ret

function fixtureBytes() {
  const types = new Uint8Array(2 * 14), tv = new DataView(types.buffer);
  [[1, 3], [5, 7]].forEach(([name, ns], i) => {
    tv.setUint32(i * 14, 1, true);
    tv.setUint16(i * 14 + 4, name, true);
    tv.setUint16(i * 14 + 6, ns, true);
    tv.setUint16(i * 14 + 8, 0, true);
    tv.setUint16(i * 14 + 10, 1, true);
    tv.setUint16(i * 14 + 12, 1, true);
  });
  const methods = new Uint8Array(14), mv = new DataView(methods.buffer);
  mv.setUint32(0, 0x3600, true); // body RVA (file offset 0x1800)
  mv.setUint16(6, 0x16, true);   // static Caller
  mv.setUint16(8, 9, true);      // 'Caller'
  mv.setUint16(10, 5, true);     // sig blob #2 (static void())
  mv.setUint16(12, 1, true);
  // MemberRef row (small indexes): parent coded (TypeDef#1 = (1<<3)|0) | name | signature
  const memberRef = new Uint8Array(6), rv = new DataView(memberRef.buffer);
  rv.setUint16(0, 0x0008, true);
  rv.setUint16(2, 12, true);     // '.ctor'
  rv.setUint16(4, 1, true);      // instance void()
  const tables = cilTables(new Map([
    [2, { count: 2, bytes: types }],
    [6, { count: 1, bytes: methods }],
    [0x0a, { count: 1, bytes: memberRef }],
  ]));
  return buildCil({
    methods: [{ name: 'Caller', owner: 0, body: NEWOBJ_MEMBERREF }],
    streams: [
      { name: '#~', bytes: tables.bytes },
      { name: '#Strings', bytes: pad(Uint8Array.from(strings)) },
      { name: '#Blob', bytes: pad(blob) },
    ],
  }).bytes;
}

// IMAGE_COR20_HEADER.Flags (II.25.3.3): ILONLY | (32BITREQUIRED), and
// IMAGE_FILE_HEADER.Characteristics: IMAGE_FILE_32BIT_MACHINE must agree.
function patchedFixture({ requires32 }) {
  const bytes = fixtureBytes().slice();
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  v.setUint32(0x200 + 16, requires32 ? 0x00000003 : 0x00000001, true);
  v.setUint16(0x80 + 22, requires32 ? 0x0100 : 0x0000, true);
  return bytes;
}

const newobjProducedValues = (requires32) => {
  const image = parseCil(patchedFixture({ requires32 }), { binaryId: `newobj-${requires32}` });
  const newobj = liftCilMethod(0, image).bundles.find((b) => b.mnemonic === 'newobj');
  return { callEffect: newobj.callEffects[0], produced: newobj.producedValues[0] };
};

const OWNER = { table: 'TypeDef', rid: 1, name: 'A', namespace: 'N' };

test('#7601+#7775 32BITREQUIRED MemberRef newobj keeps constructedType and 32-bit width together', () => {
  const { callEffect, produced } = newobjProducedValues(true);
  assert.equal(callEffect.signatureResolved, true);
  assert.equal(callEffect.callTargetResolved, true);
  assert.deepEqual(produced, {
    id: 'constructed-object',
    stackType: 'object-ref',
    constructedType: OWNER,
    bits: 32,
  });
});

test('#7601+#7775 AnyCPU MemberRef newobj keeps constructedType without fabricating a width', () => {
  const { callEffect, produced } = newobjProducedValues(false);
  assert.equal(callEffect.signatureResolved, true);
  assert.equal(callEffect.callTargetResolved, true);
  assert.deepEqual(produced.constructedType, OWNER);
  assert.equal(produced.bits, undefined);
});

test('#7601+#7775 the two width authorities produce distinct canonical newobj projections', () => {
  const x86Only = newobjProducedValues(true);
  const anyCpu = newobjProducedValues(false);
  assert.notDeepEqual(x86Only.produced, anyCpu.produced);
});
