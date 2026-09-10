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
      // #5647 review: when the caller sees the complete file (no prefix
      // truncation), the declared arch table must fit inside the input —
      // `CA FE BA BE 00 00 00 01` alone must not confirm a FAT32 image whose
      // 20-byte fat_arch entry is missing. Source-backed probes hand only a
      // short 16-byte prefix, so they declare truncated:true and leave the
      // full-table bounds to the Mach-O parser, which owns the whole input.
      const entrySize = be === 0xcafebabf || le === 0xbfbafeca ? 32 : 20;
      const tableEnd = 8 + nfatArch * entrySize;
      const truncated = options.truncated === true;
      if (!truncated && r.length < tableEnd) return { format: 'unknown' };
      return { format: 'macho', fat: true };
    }
  }
  return { format: 'unknown' };
}
