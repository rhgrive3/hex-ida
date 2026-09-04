import { ByteView } from './reader.js';

const CPU_TYPE_ARM = 12;
const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_TYPE_ARM64_32 = 0x0200000c;
const CPU_SUBTYPE_ARM_V7K = 12;
const CPU_SUBTYPE_ARM64E = 2;
const CPU_SUBTYPE_ARM64E_ABI_V0 = 0x80000002;
const MH_KEXT_BUNDLE = 11;

export function cpuName(cpu) {
  const value = cpu >>> 0;
  return ({ 7: 'x86', 12: 'arm', 18: 'ppc', 0x01000007: 'x86_64', 0x0100000c: 'arm64', 0x0200000c: 'arm64_32' })[value] || `cpu-${value}`;
}

export function subtypeBase(subtype) {
  return (subtype >>> 0) & 0x00ffffff;
}

function canonicalArchitectureSubtype(cpu, subtype) {
  const type = cpu >>> 0;
  const value = subtype >>> 0;
  if (type === CPU_TYPE_ARM64) {
    // dyld canonicalizes only the pre-versioned arm64e fat-header value to
    // the current ABI-v0 identity. Other arm64 ABI/version bits are identity.
    return value === CPU_SUBTYPE_ARM64E ? CPU_SUBTYPE_ARM64E_ABI_V0 : value;
  }
  return subtypeBase(value);
}

function sameArchitecture(cpuA, subtypeA, cpuB, subtypeB) {
  const typeA = cpuA >>> 0;
  const typeB = cpuB >>> 0;
  return typeA === typeB
    && canonicalArchitectureSubtype(typeA, subtypeA) === canonicalArchitectureSubtype(typeB, subtypeB);
}

function uses16KPages(inner) {
  const cpu = inner.cpu >>> 0;
  if (cpu === CPU_TYPE_ARM64 || cpu === CPU_TYPE_ARM64_32) return true;
  if (cpu === CPU_TYPE_ARM && (inner.subtype >>> 0) === CPU_SUBTYPE_ARM_V7K) {
    // Match UnsafeHeader::uses16KPages(): armv7k final images are 16K,
    // while the historical kext exception remains 4K-aligned.
    return inner.filetype !== MH_KEXT_BUNDLE;
  }
  return false;
}

export function sliceArchName(slice) {
  return cpuName(slice.cpu) === 'arm64' && subtypeBase(slice.subtype) === 2 ? 'arm64e' : cpuName(slice.cpu);
}

export function parseInnerMachOHeader(bytes) {
  if (!bytes || bytes.length < 28) return null;
  const r0 = new ByteView(bytes);
  const s = [r0.u8(0), r0.u8(1), r0.u8(2), r0.u8(3)].map((x) => x.toString(16).padStart(2, '0')).join('');
  let littleEndian = null, bits = null;
  if (s === 'cefaedfe') { bits = 32; littleEndian = true; }
  else if (s === 'cffaedfe') { bits = 64; littleEndian = true; }
  else if (s === 'feedface') { bits = 32; littleEndian = false; }
  else if (s === 'feedfacf') { bits = 64; littleEndian = false; }
  else return null;
  if (bits === 64 && bytes.length < 32) return null;

  const r = new ByteView(bytes, { littleEndian });
  const cpu = r.i32(4);
  const subtype = r.i32(8);
  const filetype = r.u32(12);
  return { bits, littleEndian, cpu, subtype, filetype };
}

export function validateFatSlice(slice, inner, totalBytes, opts = {}) {
  const total = BigInt(totalBytes);
  if (slice.size <= 0n || slice.offset < 0n || slice.offset + slice.size > total) {
    throw new Error('Mach-O universal binary slice is outside file bounds');
  }
  if (slice.align != null) {
    const alignVal = BigInt(slice.align);
    if (alignVal >= 64n) {
      throw new Error('Mach-O universal binary slice declared align is unreasonable');
    }
    const declaredAlignment = 1n << alignVal;
    if ((slice.offset % declaredAlignment) !== 0n) {
      throw new Error('Mach-O universal binary slice is not aligned to declared align');
    }
  }
  if (!inner) {
    throw new Error('Mach-O universal binary slice contains invalid thin header');
  }
  if (!sameArchitecture(inner.cpu, inner.subtype, slice.cpu, slice.subtype)) {
    throw new Error('Mach-O universal slice outer architecture does not match inner header');
  }
  if (opts.strictPageAlignment !== false) {
    const isObjectFile = inner.filetype === 1;
    const isDSYM = inner.filetype === 10;
    if (!isObjectFile && !isDSYM) {
      const pageMask = uses16KPages(inner) ? 0x3fffn : 0xfffn;
      if ((slice.offset & pageMask) !== 0n) {
        throw new Error('Mach-O universal binary slice is not page aligned');
      }
    }
  }
}

export function validateFatContainer(all) {
  const seen = new Set();
  for (const s of all) {
    const key = `${s.cpu >>> 0}:${canonicalArchitectureSubtype(s.cpu, s.subtype)}`;
    if (seen.has(key)) {
      throw new Error(`Mach-O universal binary contains duplicate ${sliceArchName(s)} architecture`);
    }
    seen.add(key);
  }
  for (let i = 0; i < all.length; i++) {
    const a = all[i];
    for (let j = i + 1; j < all.length; j++) {
      const b = all[j];
      if (a.offset < b.offset + b.size && b.offset < a.offset + a.size) {
        throw new Error('Mach-O universal binary slices overlap');
      }
    }
  }
}

function isCompatArm64Subtype(subtype) {
  const value = subtype >>> 0;
  return value === 0 || value === 1;
}

function checkCompatArm64Basic(cpu, subtype, offset, size, align, count, totalBytes, existingSlices) {
  if ((cpu >>> 0) !== CPU_TYPE_ARM64 || !isCompatArm64Subtype(subtype)) return false;
  const total = BigInt(totalBytes);
  if (offset < 8n + BigInt((count + 1) * 20) || size <= 0n || offset + size > total) return false;
  if (align >= 32 || (offset % (1n << BigInt(align))) !== 0n) return false;
  const dup = existingSlices.some((s) => (s.cpu >>> 0) === CPU_TYPE_ARM64 && isCompatArm64Subtype(s.subtype));
  if (dup) return false;
  const overlap = existingSlices.some((s) => offset < s.offset + s.size && s.offset < offset + size);
  if (overlap) return false;
  return true;
}

export function probePastEndArm64SliceSync(r, count, totalBytes, readHeaderBytes, existingSlices, probeOffset = 8 + count * 20) {
  if (8n + BigInt((count + 1) * 20) > BigInt(totalBytes)) return null;
  if (probeOffset + 20 > r.bytes.length) return null;
  const cpu = r.i32(probeOffset);
  const subtype = r.i32(probeOffset + 4);
  const offset = BigInt(r.u32(probeOffset + 8));
  const size = BigInt(r.u32(probeOffset + 12));
  const align = r.u32(probeOffset + 16);
  if (!checkCompatArm64Basic(cpu, subtype, offset, size, align, count, totalBytes, existingSlices)) return null;

  let headerBytes = null;
  try {
    headerBytes = readHeaderBytes(offset, Math.min(32, Number(size)));
  } catch {
    return null;
  }
  const inner = parseInnerMachOHeader(headerBytes);
  if (!inner || inner.cpu !== cpu || !isCompatArm64Subtype(inner.subtype)) return null;
  const isObject = inner.filetype === 1 || inner.filetype === 10;
  if (!isObject && (offset & 0x3fffn) !== 0n) return null;
  return { cpu, subtype, offset, size, align };
}

export async function probePastEndArm64SliceAsync(r, count, totalBytes, readHeaderBytesAsync, existingSlices, probeOffset = count * 20) {
  if (8n + BigInt((count + 1) * 20) > BigInt(totalBytes)) return null;
  if (probeOffset + 20 > r.bytes.length) return null;
  const cpu = r.i32(probeOffset);
  const subtype = r.i32(probeOffset + 4);
  const offset = BigInt(r.u32(probeOffset + 8));
  const size = BigInt(r.u32(probeOffset + 12));
  const align = r.u32(probeOffset + 16);
  if (!checkCompatArm64Basic(cpu, subtype, offset, size, align, count, totalBytes, existingSlices)) return null;

  let headerBytes = null;
  try {
    headerBytes = await readHeaderBytesAsync(offset, Math.min(32, Number(size)));
  } catch {
    return null;
  }
  const inner = parseInnerMachOHeader(headerBytes);
  if (!inner || inner.cpu !== cpu || !isCompatArm64Subtype(inner.subtype)) return null;
  const isObject = inner.filetype === 1 || inner.filetype === 10;
  if (!isObject && (offset & 0x3fffn) !== 0n) return null;
  return { cpu, subtype, offset, size, align };
}
