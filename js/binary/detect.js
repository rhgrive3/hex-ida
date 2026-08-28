import { ByteView } from './reader.js';

export function detectBinary(input) {
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
    if (fat.has(le) || fat.has(be)) return { format: 'macho', fat: true };
  }
  return { format: 'unknown' };
}
