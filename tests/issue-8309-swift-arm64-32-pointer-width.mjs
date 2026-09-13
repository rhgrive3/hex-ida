// Regression for #8309: the Swift metadata path hard-coded 8-byte native
// pointers for ABI pointer reads even on arm64_32 (watchOS ILP32, 4-byte
// pointers). resolveAbsolutePointer() always read 8 bytes, so an indirect
// protocol/type reference at a valid 4-byte slot was combined with the adjacent
// independent word into a bogus u64 and rejected, and parseSwiftWitnessTable()
// both read and advanced by 8 bytes so consecutive 4-byte witness entries were
// skipped. Passing pointerSize=4 did not help because the parser ignored it.
// Swift native pointer width is now the architecture's ABI width, shared by
// absolute resolves, witness-table stride, and the witness seed offset, and an
// unknown ABI fails closed instead of fabricating an LP64 read.
import assert from 'node:assert/strict';
import {
  buildSwiftMetadataModel,
  parseSwiftConformanceDescriptor,
  parseSwiftWitnessTable,
  swiftNativePointerBytes,
} from '../js/swift.js';

function fixture() {
  const mem = new Uint8Array(0x2000);
  const dv = new DataView(mem.buffer);
  const putI32 = (a, v) => dv.setInt32(a, v, true);
  const putU32 = (a, v) => dv.setUint32(a, v, true);
  const read = async (addr, len) => {
    const o = Number(addr);
    return o < 0 || o + len > mem.length ? null : mem.slice(o, o + len);
  };
  const resolvePointer = async (raw) => (raw <= 0xffffffffn ? raw : null);
  return { mem, dv, putI32, putU32, read, resolvePointer };
}

// 1. Indirect protocol reference at a 4-byte slot: the following independent
//    4-byte word must not be consumed as the high half of an 8-byte pointer.
{
  const { putI32, putU32, read, resolvePointer } = fixture();
  const conf = 0x200, slot = 0x300;
  putI32(conf, (slot - conf) | 1);       // indirect RelativeIndirectablePointer
  putI32(conf + 4, 0x700 - (conf + 4));  // direct relative type reference
  putI32(conf + 8, 0x800 - (conf + 8));
  putU32(conf + 12, 0);
  putU32(slot, 0x600);                   // valid arm64_32 native pointer
  putU32(slot + 4, 0x12345678);          // unrelated adjacent word

  const bySize = await parseSwiftConformanceDescriptor(read, BigInt(conf), { pointerSize: 4, resolvePointer });
  assert.notEqual(bySize, null, 'pointerSize:4 must resolve the indirect protocol pointer');
  assert.equal(bySize.protocol, 0x600n, 'the adjacent word must not be read as a high half');

  const byArch = await parseSwiftConformanceDescriptor(read, BigInt(conf), { architecture: 'arm64_32', resolvePointer });
  assert.notEqual(byArch, null, 'architecture arm64_32 must derive a 4-byte pointer width');
  assert.equal(byArch.protocol, 0x600n);

  // Control: the same slot parsed with the LP64 ABI is genuinely 8 bytes wide,
  // so the combined value is rejected by the canonical resolver. This proves the
  // width, not the fixture, decides the result.
  const lp64 = await parseSwiftConformanceDescriptor(read, BigInt(conf), { architecture: 'arm64', resolvePointer });
  assert.equal(lp64, null);
}

// 2. Witness-table entries use the native pointer width as both read size and
//    stride: two consecutive 4-byte entries stay two distinct entries.
{
  const { putU32, read, resolvePointer } = fixture();
  putU32(0x900, 0x0a00);
  putU32(0x904, 0x0b00);
  putU32(0x908, 0);
  putU32(0x90c, 0);

  const arm64_32 = await parseSwiftWitnessTable(read, 0x900n, 2, 4096, { architecture: 'arm64_32', resolvePointer });
  assert.equal(arm64_32.length, 2);
  assert.equal(arm64_32[0].target, 0x0a00n, 'first 4-byte entry decodes independently');
  assert.equal(arm64_32[1].target, 0x0b00n, 'stride must advance by 4 bytes, not 8');
  assert.equal(arm64_32.every((e) => e.resolved === true), true);

  const bySize = await parseSwiftWitnessTable(read, 0x900n, 2, 4096, { pointerSize: 4, resolvePointer });
  assert.equal(bySize[1].target, 0x0b00n);

  // LP64 control on the same bytes: entry 0 combines both words, entry 1 reads
  // the zero sentinel, so the results differ.
  const lp64 = await parseSwiftWitnessTable(read, 0x900n, 2, 4096, { architecture: 'arm64', resolvePointer });
  assert.equal(lp64[0].target, null, 'combined 8-byte read is rejected by the resolver');
  assert.equal(lp64[1].target, null);

  // Unknown ABI fails closed: no entries are fabricated.
  const unknown = await parseSwiftWitnessTable(read, 0x900n, 2, 4096, { architecture: 'mips64', resolvePointer });
  assert.deepEqual([...unknown], []);
}

// 3. The architecture authority itself is explicit and total.
{
  assert.equal(swiftNativePointerBytes('arm64_32'), 4);
  assert.equal(swiftNativePointerBytes('arm64'), 8);
  assert.equal(swiftNativePointerBytes('arm64e'), 8);
  assert.equal(swiftNativePointerBytes('x86_64'), 8);
  assert.equal(swiftNativePointerBytes('armv7k'), 4);
  assert.equal(swiftNativePointerBytes(null), null);
  assert.throws(() => swiftNativePointerBytes('mips64'), /swift-unknown-pointer-abi/);
}

// 4. Production model path: the same conformance section parses on arm64_32 and
//    fails closed on an unknown ABI, without any explicit pointerSize option.
{
  const build = async (opts) => {
    const { putI32, putU32, read, resolvePointer } = fixture();
    const conf = 0x200, slot = 0x300;
    putI32(conf, (slot - conf) | 1);
    putI32(conf + 4, 0x700 - (conf + 4));
    putI32(conf + 8, 0x800 - (conf + 8));
    putU32(conf + 12, 0);
    putU32(slot, 0x600);
    putU32(slot + 4, 0x12345678);
    putI32(0x100, conf - 0x100);          // one __swift5_proto relative entry
    return buildSwiftMetadataModel(read, [
      { section: '__swift5_proto', vmAddr: 0x100n, size: 4n },
    ], { resolvePointer, ...opts });
  };

  const arm64_32 = await build({ architecture: 'arm64_32' });
  assert.equal(arm64_32.conformances.length, 1, 'arm64_32 must resolve the conformance');
  assert.equal(arm64_32.completeness.conformances.parsed, 1);
  assert.equal(arm64_32.completeness.conformances.invalidEntries, 0);

  // Same bytes with no architecture information keep the documented LP64 default
  // (backwards compatible for callers that make no ABI claim), so this 4-byte
  // fixture is genuinely not resolvable as an 8-byte pointer.
  const unspecified = await build({});
  assert.equal(unspecified.conformances.length, 0);
  assert.equal(unspecified.completeness.conformances.complete, false);

  // An unknown ABI is declared, so it must not publish a fabricated conformance.
  const unknown = await build({ architecture: 'unknown' });
  assert.equal(unknown.conformances.length, 0);
  assert.equal(unknown.completeness.conformances.complete, false);
}

// 5. Witness-table stride reaches the model path too.
{
  const { putU32, read, resolvePointer } = fixture();
  putU32(0x900, 0x0a00);
  putU32(0x904, 0x0b00);
  putU32(0x908, 0);
  putU32(0x90c, 0);
  const model = await buildSwiftMetadataModel(read, [], {
    architecture: 'arm64_32',
    resolvePointer,
    witnessTables: [{ address: 0x900n, count: 2 }],
  });
  assert.equal(model.witnessTables.length, 1);
  assert.equal(model.witnessTables[0].entries.length, 2);
  assert.equal(model.witnessTables[0].entries[1].target, 0x0b00n);
  assert.equal(model.completeness.witnessTables.complete, true);
}

console.log('issue #8309 Swift ARM64_32 native pointer width regression passed');
