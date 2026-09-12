import { ByteView } from './reader.js';

export function detectBinary(input, options = {}) {
  const r = new ByteView(input, { littleEndian: true });
  if (r.length >= 4) {
    const b0 = r.u8(0), b1 = r.u8(1), b2 = r.u8(2), b3 = r.u8(3);
    if (b0 === 0x7f && b1 === 0x45 && b2 === 0x4c && b3 === 0x46) return { format: 'elf' };
    if (b0 === 0x4d && b1 === 0x5a) {
      // MZ is only a DOS-header precondition; PE requires the e_lfanew signature.
      // Keep this maintainer-owned head after canonical generated synchronization.
      if (r.length < 0x40) return { format: 'unknown' };
      const pe = r.u32(0x3c, true);
      if (pe + 4 > r.length || r.u32(pe, true) !== 0x00004550) return { format: 'unknown' };
      return { format: 'pe' };
    }
    const le = r.u32(0, true);
    const be = r.u32(0, false);
    const macho = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe]);
    const fat = new Set([0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca]);
    if (macho.has(le) || macho.has(be)) return { format: 'macho', fat: false };
    if (fat.has(le) || fat.has(be)) {
      // A universal header is magic + nfat_arch at minimum, and 0xCAFEBABE is
      // also the JVM class-file magic: magic alone cannot confirm the format
      // (#5647). Require the 8-byte header and a plausible architecture count
      // before confirming Mach-O. Fat header fields are big-endian on disk for
      // both MAGIC and CIGAM byte orders. JVM class files surface their
      // minor:major version words in bytes 4-7 with major_version >= 45 for
      // every real class file, so the 1..16 window rejects all of them while
      // keeping every real fat image.
      if (r.length < 8) return { format: 'unknown' };
      const fatLittleEndian = be === 0xbebafeca || be === 0xbfbafeca;
      const nfatArch = r.u32(4, fatLittleEndian);
      if (nfatArch < 1 || nfatArch > 16) return { format: 'unknown' };
      // Complete inputs must contain the declared arch table. Prefix probes
      // may defer that structural check only when their size metadata is
      // internally consistent, and stay explicitly provisional (#5647).
      const entrySize = be === 0xcafebabf || be === 0xbfbafeca ? 32 : 20;
      const tableEnd = 8 + nfatArch * entrySize;
      const asSize = (value) => {
        if (typeof value === 'bigint') return value;
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
        return null;
      };
      const probeLength = asSize(options.probeLength);
      const totalSize = asSize(options.totalSize);
      const inputLength = BigInt(r.length);
      const trustedPrefix = probeLength != null && totalSize != null
        && probeLength === inputLength && totalSize > probeLength;
      if (trustedPrefix) return { format: 'macho', fat: true, truncated: true };
      if (r.length < tableEnd) return { format: 'unknown' };
      return { format: 'macho', fat: true };
    }
  }
  return { format: 'unknown' };
}
