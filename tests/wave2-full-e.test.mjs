import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ObjcMetadataProvider,
  probeCanonicalObjcMetadata,
} from '../js/metadata/objc.js';
import {
  isAuthoritative,
} from '../js/metadata/provider.js';
import {
  demangleRustLegacy,
  demangleRustSymbol,
  RustMetadataProvider,
} from '../js/metadata/rust.js';
import {
  parseGoTypeDescriptor,
} from '../js/metadata/go.js';

// ---------------------------------------------------------------------------
// Bug 1 & Bug 2: Objective-C metadata provider
// ---------------------------------------------------------------------------

test('Wave2-E #1: probeCanonicalObjcMetadata handles incomplete runtime model without TypeError', async () => {
  // Construct a minimal 64-bit __objc_classlist with 2 entries:
  // entry 0: valid class_t at 0x2000 -> name "Alpha"
  // entry 1: unreadable pointer 0x9999 -> forces runtimeCompleteness.complete === false
  const mem = new Map();
  const putU64 = (addr, val) => {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigUint64(0, BigInt(val), true);
    mem.set(addr, buf);
  };
  const putCString = (addr, str) => {
    const encoded = new TextEncoder().encode(`${str}\0`);
    mem.set(addr, encoded);
  };

  // __objc_classlist at 0x1000, size 16 (2 pointers)
  putU64(0x1000n, 0x2000n);
  putU64(0x1008n, 0x9999n);

  // class_t at 0x2000 (isa, superclass, cache, vtable, data)
  putU64(0x2000n, 0n);
  putU64(0x2008n, 0n);
  putU64(0x2010n, 0n);
  putU64(0x2018n, 0n);
  putU64(0x2020n, 0x3000n); // class_ro_t

  // class_ro_t at 0x3000: flags(4), instanceStart(4), instanceSize(4), reserved(4), ivarLayout(8), name(8), baseMethods(8)
  const ro = new Uint8Array(72);
  const roView = new DataView(ro.buffer);
  roView.setUint32(0, 0, true);
  roView.setUint32(4, 0, true);
  roView.setUint32(8, 8, true);
  roView.setBigUint64(24, 0x4000n, true); // name
  roView.setBigUint64(32, 0n, true); // baseMethods
  mem.set(0x3000n, ro);

  putCString(0x4000n, 'Alpha');

  const readAt = async (addr, len) => {
    const target = BigInt(addr);
    for (const [base, bytes] of mem.entries()) {
      if (target >= base && target < base + BigInt(bytes.length)) {
        const off = Number(target - base);
        if (off + len <= bytes.length) {
          return bytes.subarray(off, off + len);
        }
        // Return available slice for cstring reads
        return bytes.subarray(off);
      }
    }
    return null;
  };

  const origTypes = ObjcMetadataProvider.prototype.types;
  const origMethods = ObjcMetadataProvider.prototype.methods;
  ObjcMetadataProvider.prototype.types = () => {
    throw new Error('prototype types must not be called');
  };
  ObjcMetadataProvider.prototype.methods = () => {
    throw new Error('prototype methods must not be called');
  };

  try {
    const result = await probeCanonicalObjcMetadata({
      readAt,
      sections: [{ name: '__objc_classlist', vmAddr: 0x1000n, size: 16 }],
      binaryIdentity: 'sha256:wave2-e-objc',
    });

    assert.equal(result.completeness.complete, false);
    assert.equal(result.identity.verdict, 'matched-partial');
    assert.ok(Array.isArray(result.identity.coverage?.entityIds));
    assert.ok(result.identity.coverage.entityIds.includes('type@0x2000'));
  } finally {
    ObjcMetadataProvider.prototype.types = origTypes;
    ObjcMetadataProvider.prototype.methods = origMethods;
  }
});

test('Wave2-E #2: ObjcMetadataProvider.probe() incomplete() fails closed with identity-unavailable when binaryIdentity is null', async () => {
  const readAt = async () => new Uint8Array(8);

  // Case 1: multiple classList sections without binaryIdentity
  const multiProvider = new ObjcMetadataProvider({
    readAt,
    binaryIdentity: null,
    sections: [
      { name: '__objc_classlist', vmAddr: 0x1000n, size: 8 },
      { name: '__objc_classlist', vmAddr: 0x2000n, size: 8 },
    ],
  });
  const multiRes = await multiProvider.probe();
  assert.equal(multiRes.identity.verdict, 'identity-unavailable');
  assert.equal(isAuthoritative(multiRes.identity), false);
  assert.equal(multiRes.completeness.complete, false);
  assert.ok(multiRes.completeness.reasons.includes('objc-multiple-classList-sections'));

  // Case 2: invalid range without binaryIdentity
  const invalidRangeProvider = new ObjcMetadataProvider({
    readAt,
    binaryIdentity: null,
    sections: [
      { name: '__objc_classlist', vmAddr: -1, size: 8 },
    ],
  });
  const invalidRes = await invalidRangeProvider.probe();
  assert.equal(invalidRes.identity.verdict, 'identity-unavailable');
  assert.equal(isAuthoritative(invalidRes.identity), false);
  assert.equal(invalidRes.completeness.complete, false);
  assert.ok(invalidRes.completeness.reasons.includes('objc-classList-range-invalid'));

  // Case 3: with binaryIdentity present, incomplete() keeps matched-partial
  const boundProvider = new ObjcMetadataProvider({
    readAt,
    binaryIdentity: 'sha256:bound',
    sections: [
      { name: '__objc_classlist', vmAddr: -1, size: 8 },
    ],
  });
  const boundRes = await boundProvider.probe();
  assert.equal(boundRes.identity.verdict, 'matched-partial');
  assert.equal(boundRes.completeness.complete, false);
});

// ---------------------------------------------------------------------------
// Bug 3: Rust legacy demangler stats & aggregate budget enforcement
// ---------------------------------------------------------------------------

test('Wave2-E #3: demangleRustLegacy returns stats on all outcomes and RustMetadataProvider enforces aggregate budget', () => {
  const ok = demangleRustLegacy('_ZN3foo3bar17h0123456789abcdefE');
  assert.equal(ok.parsed, true);
  assert.equal(ok.demangled, 'foo::bar');
  assert.deepEqual(ok.stats, {
    ops: 3,
    outputChars: 8,
    scalars: 0,
    encodedBytes: 0,
    spliceWork: 0,
  });

  const nonLegacy = demangleRustLegacy('plain_c_symbol');
  assert.equal(nonLegacy.parsed, false);
  assert.deepEqual(nonLegacy.stats, {
    ops: 0,
    outputChars: 0,
    scalars: 0,
    encodedBytes: 0,
    spliceWork: 0,
  });

  const opsLimited = demangleRustLegacy('_ZN3foo3barE', { maxOps: 1 });
  assert.equal(opsLimited.parsed, false);
  assert.equal(opsLimited.resourceLimited, true);
  assert.equal(opsLimited.stats.ops, 1);

  const charsLimited = demangleRustLegacy('_ZN3foo6barbazE', { maxOutputChars: 5 });
  assert.equal(charsLimited.parsed, false);
  assert.equal(charsLimited.resourceLimited, true);
  assert.equal(charsLimited.stats.outputChars, 3);

  const truncated = demangleRustLegacy('_ZN3foo');
  assert.equal(truncated.parsed, false);
  assert.equal(truncated.reason, 'unrecognized-legacy-structure');
  assert.equal(truncated.stats.ops, 1);

  const trailing = demangleRustLegacy('_ZN3fooEextra');
  assert.equal(trailing.parsed, false);
  assert.equal(trailing.reason, 'unconsumed-legacy-trailing-bytes');
  assert.equal(trailing.stats.ops, 1);

  // Aggregate ops budget across multiple legacy symbols
  const opsProvider = new RustMetadataProvider({
    symbols: [
      { name: '_ZN3foo3barE', address: 0x1000 }, // 2 ops
      { name: '_ZN3baz3quxE', address: 0x1010 }, // 2 ops -> aggregate ops = 4
      { name: '_ZN4next4itemE', address: 0x1020 }, // remaining maxOps = 0 -> blocked!
    ],
    options: {
      rustDemangle: {
        aggregateMaxOps: 4,
      },
    },
  });
  const opsResult = opsProvider.probe();
  assert.equal(opsResult.counts.symbols, 2);
  assert.equal(opsResult.completeness.complete, false);

  // Aggregate outputChars budget across multiple legacy symbols
  const charsProvider = new RustMetadataProvider({
    symbols: [
      { name: '_ZN5alpha4betaE', address: 0x2000 }, // 'alpha::beta' = 11 chars
      { name: '_ZN5gamma5deltaE', address: 0x2010 }, // 'gamma::delta' = 12 chars -> remaining < 12 -> blocked!
    ],
    options: {
      rustDemangle: {
        aggregateMaxOutputChars: 15,
      },
    },
  });
  const charsResult = charsProvider.probe();
  assert.equal(charsResult.counts.symbols, 1);
  assert.equal(charsResult.completeness.complete, false);

  // Malformed legacy Rust symbols must still preserve stats through demangleRustSymbol()
  // so they cannot bypass RustMetadataProvider aggregate budgets.
  const malformedTruncated = demangleRustSymbol('_ZN3foo3bar');
  assert.equal(malformedTruncated.parsed, false);
  assert.equal(malformedTruncated.reason, 'not-rust-symbol');
  assert.deepEqual(malformedTruncated.stats, {
    ops: 2,
    outputChars: 8,
    scalars: 0,
    encodedBytes: 0,
    spliceWork: 0,
  });

  const malformedTrailing = demangleRustSymbol('_ZN3baz3quxEextra');
  assert.equal(malformedTrailing.parsed, false);
  assert.equal(malformedTrailing.reason, 'not-rust-symbol');
  assert.deepEqual(malformedTrailing.stats, {
    ops: 2,
    outputChars: 8,
    scalars: 0,
    encodedBytes: 0,
    spliceWork: 0,
  });

  const malformedOpsProvider = new RustMetadataProvider({
    symbols: [
      { name: '_ZN3foo3bar', address: 0x3000 },       // 2 ops (unterminated)
      { name: '_ZN3baz3quxEextra', address: 0x3010 }, // 2 ops (trailing bytes) -> aggregate ops = 4
      { name: '_ZN4next4itemE', address: 0x3020 },    // remaining maxOps = 0 -> blocked!
    ],
    options: {
      rustDemangle: {
        aggregateMaxOps: 4,
      },
    },
  });
  const malformedOpsResult = malformedOpsProvider.probe();
  assert.equal(malformedOpsResult.counts.symbols, 0);
  assert.equal(malformedOpsResult.completeness.complete, false);
  assert.equal(malformedOpsResult.completeness.unreadableEntries, 3);

  const malformedCharsProvider = new RustMetadataProvider({
    symbols: [
      { name: '_ZN5alpha4beta', address: 0x4000 },    // 'alpha::beta' = 11 chars (unterminated)
      { name: '_ZN5gamma5deltaE', address: 0x4010 },  // 'gamma::delta' = 12 chars -> remaining < 12 -> blocked!
    ],
    options: {
      rustDemangle: {
        aggregateMaxOutputChars: 15,
      },
    },
  });
  const malformedCharsResult = malformedCharsProvider.probe();
  assert.equal(malformedCharsResult.counts.symbols, 0);
  assert.equal(malformedCharsResult.completeness.complete, false);
  assert.equal(malformedCharsResult.completeness.unreadableEntries, 2);
});

// ---------------------------------------------------------------------------
// Bug 4: Go 1.16 vs 1.17+ reflect.name length prefix decoding
// ---------------------------------------------------------------------------

function makeGoTypeBuffer({ ptrSize = 8, little = true, strOff = 0x60, nameBytes }) {
  const headerBytes = ptrSize * 4 + 16;
  const buf = new Uint8Array(Math.max(headerBytes, strOff + nameBytes.length + 16));
  const dv = new DataView(buf.buffer);
  if (ptrSize === 8) {
    dv.setBigUint64(0, 16n, little);
    dv.setBigUint64(8, 8n, little);
  } else {
    dv.setUint32(0, 16, little);
    dv.setUint32(4, 8, little);
  }
  dv.setUint32(ptrSize * 2, 0x11223344, little);
  buf[ptrSize * 2 + 4] = 0;
  buf[ptrSize * 2 + 5] = ptrSize;
  buf[ptrSize * 2 + 6] = ptrSize;
  buf[ptrSize * 2 + 7] = 25; // struct
  dv.setInt32(ptrSize * 4 + 8, strOff, little);
  buf.set(nameBytes, strOff);
  return buf;
}

test('Wave2-E #4: parseGoTypeDescriptor decodes Go 1.16 2-byte big-endian name length vs Go 1.17+ uvarint', () => {
  // Go 1.16: 1-byte flags + 2-byte big-endian length
  const shortText = 'Go116Struct';
  const shortEncoded = new TextEncoder().encode(shortText);
  const go116Short = makeGoTypeBuffer({
    nameBytes: new Uint8Array([0x00, 0x00, shortEncoded.length, ...shortEncoded]),
  });
  const desc116Short = parseGoTypeDescriptor(go116Short, 0, {
    ptrSize: 8, little: true, typesBase: 0, version: '1.16.5',
  });
  assert.equal(desc116Short?.name, shortText);

  // Go 1.16 long name (>= 256 bytes, e.g. 260 = 0x0104)
  const longText116 = 'A'.repeat(260);
  const longEncoded116 = new TextEncoder().encode(longText116);
  const go116Long = makeGoTypeBuffer({
    nameBytes: new Uint8Array([0x01, 0x01, 0x04, ...longEncoded116]),
  });
  const desc116Long = parseGoTypeDescriptor(go116Long, 0, {
    ptrSize: 8, little: true, typesBase: 0, version: '1.16.0',
  });
  assert.equal(desc116Long?.name, longText116);

  // Go 1.16 truncated 2-byte name record (missing 3rd byte) fails closed
  const go116Truncated = new Uint8Array(0x62);
  go116Truncated.set(go116Short.subarray(0, 0x62), 0);
  const desc116Truncated = parseGoTypeDescriptor(go116Truncated, 0, {
    ptrSize: 8, little: true, typesBase: 0, version: '1.16.0',
  });
  assert.equal(desc116Truncated?.name, 'go_type_struct_0');

  // Go 1.17+: 1-byte flags + uvarint length (260 = 0x84, 0x02)
  const go117Long = makeGoTypeBuffer({
    nameBytes: new Uint8Array([0x01, 0x84, 0x02, ...longEncoded116]),
  });
  const desc117Long = parseGoTypeDescriptor(go117Long, 0, {
    ptrSize: 8, little: true, typesBase: 0, version: '1.17.0',
  });
  assert.equal(desc117Long?.name, longText116);
});
