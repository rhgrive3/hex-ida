import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCil } from '../fixtures/medium-cil.mjs';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { probeCil } from '../../../js/managed/cil/parser.js';
import { liftCilMethod } from '../../../js/managed/cil/lifter.js';

// #7775 — the CLI header Flags field is the loader's native pointer-width
// authority. `COMIMAGE_FLAGS_32BITREQUIRED` (II.25.3.3.1) means the image
// only loads into a 32-bit process, so native-size values (`O`, `&`,
// `native int`, ECMA-335 I.12.1.1) are 32 bits there; PE32+ is a known
// 64-bit target; anything else leaves the width unresolved. Dropping the
// flags collapsed AnyCPU and x86-only images into identical canonical
// projections with a fabricated 64-bit exact `O` width.

function fixture({ requires32, pe32Plus = false, buildOptions = {} } = {}) {
  const built = buildCil({
    methods: [{ name: 'Run', body: [0x14, 0x26, 0x2a] }], // ldnull; pop; ret
    ...buildOptions,
  });
  const bytes = built.bytes.slice();
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // IMAGE_COR20_HEADER.Flags (II.25.3.3): ILONLY | (32BITREQUIRED).
  v.setUint32(0x200 + 16, requires32 ? 0x00000003 : 0x00000001, true);
  // IMAGE_FILE_HEADER.Characteristics: IMAGE_FILE_32BIT_MACHINE must agree.
  v.setUint16(0x80 + 22, requires32 ? 0x0100 : 0x0000, true);
  if (pe32Plus) {
    // PE32+ optional header: magic 0x20b, larger optional header (0xf0) and
    // the data directories start 16 bytes later — relocate the section table
    // and write the CLI directory at the PE32+ slot.
    v.setUint16(0x98, 0x20b, true);
    v.setUint16(0x94, 0xf0, true);
    bytes.copyWithin(0x188, 0x178, 0x1a0); // move the 40-byte section entry
    v.setUint32(0x104, 16, true);          // NumberOfRvaAndSizes (PE32+ offset)
    v.setUint32(0x178, 0x2000, true);      // PE32+ CLI directory RVA (dir #14)
    v.setUint32(0x17c, 72, true);          // PE32+ CLI directory size
  }
  return bytes;
}

test('#7775 canonical image retains the CLI 32BITREQUIRED authority', () => {
  const anyCpu = parseCil(fixture({ requires32: false }), { binaryId: 'same' });
  const x86Only = parseCil(fixture({ requires32: true }), { binaryId: 'same' });
  assert.equal(anyCpu.requires32Bit, false);
  assert.equal(x86Only.requires32Bit, true);
  assert.equal(x86Only.cliFlags & 0x00000002, 0x00000002);
  assert.equal(anyCpu.cliFlags & 0x00000002, 0);
  // The two images are no longer identical through the canonical projection.
  assert.notDeepEqual(
    { r: anyCpu.requires32Bit, f: anyCpu.cliFlags, l: liftCilMethod(0, anyCpu) },
    { r: x86Only.requires32Bit, f: x86Only.cliFlags, l: liftCilMethod(0, x86Only) },
  );
});

test('#7775 32BITREQUIRED images carry 32-bit native-size object references', () => {
  const image = parseCil(fixture({ requires32: true }), { binaryId: 'x86' });
  const ldnull = liftCilMethod(0, image).bundles.find((b) => b.mnemonic === 'ldnull');
  assert.deepEqual(ldnull.producedValues, [{ bits: 32, isNull: true }]);
});

test('#7775 unresolved-width images keep native-size values unstated', () => {
  const image = parseCil(fixture({ requires32: false }), { binaryId: 'any' });
  const ldnull = liftCilMethod(0, image).bundles.find((b) => b.mnemonic === 'ldnull');
  assert.deepEqual(ldnull.producedValues, [{ isNull: true }]);
});

test('#7775 PE32+ images are known 64-bit native-size targets', () => {
  const bytes = fixture({ requires32: false, pe32Plus: true });
  const image = parseCil(bytes, { binaryId: 'pe32plus' });
  assert.equal(image.requires64Bit, true);
  const ldnull = liftCilMethod(0, image).bundles.find((b) => b.mnemonic === 'ldnull');
  assert.deepEqual(ldnull.producedValues, [{ bits: 64, isNull: true }]);
});

test('#7775 32BITREQUIRED without IMAGE_FILE_32BIT_MACHINE fails closed', () => {
  const built = buildCil({ methods: [{ name: 'Run', body: [0x14, 0x26, 0x2a] }] });
  const bytes = built.bytes.slice();
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  v.setUint32(0x200 + 16, 0x00000003, true); // ILONLY | 32BITREQUIRED
  v.setUint16(0x80 + 22, 0x0000, true);      // but no 32BIT_MACHINE
  assert.throws(() => parseCil(bytes, { binaryId: 'contradictory' }),
    /cil-32bitrequired-machine-characteristic-mismatch|cil-unsupported-binary/);
  assert.equal(probeCil(bytes).supported, false);
});

test('#7775 non-32BITREQUIRED images still validate with or without the machine bit', () => {
  assert.equal(probeCil(fixture({ requires32: false })).supported, true);
});

// Production frontend paths (#7775 R2): the signature-resolved replacement in
// the public lifter must not strip the width authority — constructed objects
// (`newobj`), string references (`ldstr`), and call-return object refs carry
// the image's native pointer width on the final `liftCilMethod()` output.

const LDC_I4_1_RET = Uint8Array.from([0x00, 0x00, 0x08]); // static int32 f()
const retType = (bytes) => bytes[bytes.length - 1];

test('#7775 newobj constructed objects keep the width on the public output', () => {
  // instance void .ctor() on MethodDef #1, called as `newobj 0x06000001` from
  // Run (MethodDef #2, body index 1 after the ctor's).
  for (const requires32 of [true, false]) {
    const image = parseCil(fixture({
      requires32,
      buildOptions: {
        methods: [
          { name: '.ctor', flags: 0x0006, signature: Uint8Array.from([0x20, 0x00, 0x01]), body: [0x2a] },
          { name: 'Run', body: [0x73, 0x01, 0x00, 0x00, 0x06, 0x26, 0x2a] },
        ],
      },
    }), { binaryId: `newobj-${requires32}` });
    const fx = liftCilMethod(1, image);
    const newobj = fx.bundles.find((b) => b.mnemonic === 'newobj');
    assert.equal(newobj.callEffects[0].signatureResolved, true);
    const constructed = newobj.producedValues.find((v) => v.id === 'constructed-object');
    assert.ok(constructed, 'newobj must produce a constructed-object value');
    if (requires32) assert.equal(constructed.bits, 32);
    else assert.equal(constructed.bits, undefined);
  }
});

test('#7775 ldstr values keep the width on the public output', () => {
  // #Strings fixture heap has 'Run' at a nonzero index; ldstr reads its token
  // opaquely from the bytecode, so any nonzero user-string index works.
  for (const requires32 of [true, false]) {
    const image = parseCil(fixture({
      requires32,
      buildOptions: { methods: [{ name: 'Run', body: [0x72, 0x01, 0x00, 0x00, 0x70, 0x26, 0x2a] }] },
    }), { binaryId: `ldstr-${requires32}` });
    const ldstr = liftCilMethod(0, image).bundles.find((b) => b.mnemonic === 'ldstr');
    assert.equal(ldstr.producedValues.length, 1);
    if (requires32) assert.equal(ldstr.producedValues[0].bits, 32);
    else assert.equal(ldstr.producedValues[0].bits, undefined);
  }
});

test('#7775 call-result object references keep the width on the public output', () => {
  // static FixtureType f() returning an object ref; the resolved call-result
  // is an object-ref, so the width authority attaches on the public output.
  for (const requires32 of [true, false]) {
    const image = parseCil(fixture({
      requires32,
      buildOptions: {
        methods: [
          { name: 'StaticTarget', signature: Uint8Array.from([0x00, 0x00, 0x12, 0x04]) },
          { name: 'Run', body: [0x28, 0x01, 0x00, 0x00, 0x06, 0x26, 0x2a] },
        ],
      },
    }), { binaryId: `call-${requires32}` });
    const fx = liftCilMethod(0, image);
    const call = fx.bundles.find((b) => b.mnemonic === 'call');
    assert.equal(call.callEffects[0].signatureResolved, true);
    assert.deepEqual(call.producedValues, [{
      id: 'call-result',
      stackType: 'object-ref',
      typeToken: 4,
      ...(requires32 ? { bits: 32 } : {}),
    }]);
  }
});
