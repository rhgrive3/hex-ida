import assert from 'node:assert/strict';
import { ByteView } from '../js/binary/reader.js';
import { parseTlsDirectory } from '../js/binary/pe-loader.js';

function imageWithSections(sections) {
  return {
    imageBase: 0x140000000n, bits: 64, sections, segments: [...sections],
    metadata: {}, warnings: [], symbols: [], functions: [], imports: [], exports: [], relocations: [], libraries: [],
    sectionAt(address) {
      const a = BigInt(address);
      return sections.find((s) => a >= s.address && a < s.address + s.size) || null;
    },
  };
}

// ── #2630: TLS callback target in executable zero-fill tail must not be accepted as seed ──
{
  const textSec = {
    index: 1,
    address: 0x140001000n, // RVA 0x1000
    size: 0x200n,          // VirtualSize 0x200 (range 0x140001000..0x140001200)
    fileOffset: 0x200n,
    fileSize: 0x100n,      // SizeOfRawData 0x100 (file-backed 0x140001000..0x140001100)
    perms: { read: true, execute: true },
  };

  const rdataSec = {
    index: 2,
    address: 0x140002000n, // RVA 0x2000
    size: 0x200n,
    fileOffset: 0x300n,
    fileSize: 0x200n,
    perms: { read: true, execute: false },
  };

  const bytes = new Uint8Array(0x1000);
  const dv = new DataView(bytes.buffer);

  // TLS Directory at RVA 0x2000 (offset 0x300 in buffer)
  // PE64 TLS Directory structure:
  // offset 0: StartAddressOfRawData (8 bytes)
  // offset 8: EndAddressOfRawData (8 bytes)
  // offset 16: AddressOfIndex (8 bytes)
  // offset 24: AddressOfCallBacks (8 bytes) -> point to RVA 0x2050 (0x140002050n, file offset 0x350)
  // offset 32: SizeOfZeroFill (4 bytes)
  // offset 36: Characteristics (4 bytes)
  const tlsDirOffset = 0x300;
  dv.setBigUint64(tlsDirOffset + 24, 0x140002050n, true);

  // Callback array at file offset 0x350:
  // callback[0]: 0x140001080n (file-backed inside .text, RVA 0x1080 < 0x1100) -> should be ACCEPTED
  // callback[1]: 0x140001180n (zero-fill tail inside .text, RVA 0x1180 >= 0x1100) -> should be REJECTED (#2630)
  // callback[2]: 0x140002100n (inside .rdata, non-executable) -> should be REJECTED
  // callback[3]: 0n (null terminator)
  const cbOffset = 0x350;
  dv.setBigUint64(cbOffset + 0, 0x140001080n, true);
  dv.setBigUint64(cbOffset + 8, 0x140001180n, true);
  dv.setBigUint64(cbOffset + 16, 0x140002100n, true);
  dv.setBigUint64(cbOffset + 24, 0n, true);

  const image = imageWithSections([textSec, rdataSec]);
  parseTlsDirectory(new ByteView(bytes), { rva: 0x2000, size: 40 }, image);

  // Verify only the file-backed callback was accepted
  assert.equal(image.metadata.tls.callbacks.length, 1);
  assert.equal(image.metadata.tls.callbacks[0], 0x140001080n);
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].address, 0x140001080n);
  assert.equal(image.functions[0].source, 'tls-callback');
}

console.log('Issue #2630 PE TLS zero-fill callback test PASS!');
