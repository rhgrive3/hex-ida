import { architectureCapability } from '../architecture/index.js';
import { DEPLOYED_CAPSTONE_SUPPORT } from './capstone-capability.js';
import { supportDisplayForTruth, supportTruthForImage } from './support-capability.js';

function displayFormat(image) {
  if (image.format === 'elf') return `ELF ${image.bits || '?'}-bit`;
  if (image.format === 'pe') return image.bits === 64 ? 'PE32+' : 'PE32';
  if (image.format === 'macho') return `Mach-O ${image.bits || '?'}-bit`;
  return String(image.format || 'Raw binary');
}

function regionFrom(item, id, kind) {
  const fileSize = BigInt(item.fileSize ?? item.size ?? 0);
  const declaredSize = BigInt(item.size ?? fileSize);
  const section = kind === 'section' ? item.name || '' : null;
  return {
    id,
    kind,
    name: item.name || (kind === 'segment' ? `Segment ${id}` : `Section ${id}`),
    segment: item.segment || (kind === 'segment' ? item.name || null : null),
    section,
    fileOffset: BigInt(item.fileOffset ?? 0),
    vmAddr: BigInt(item.address ?? 0),
    size: fileSize,
    declaredSize,
    exec: !!item.perms?.execute,
    write: !!item.perms?.write,
    read: !!item.perms?.read,
    zerofill: fileSize === 0n && declaredSize > 0n,
    truncated: false,
    cstrings: /cstring|string|strtab|rdata|rodata/i.test(item.name || ''),
  };
}

export function regionsForImage(image, prefix = 'p0_') {
  const sections = image.sections || [];
  const segments = image.segments || [];
  const usefulSections = sections.filter((s) => BigInt(s.fileSize ?? s.size ?? 0) > 0n || BigInt(s.size ?? 0n) > 0n);
  if (!usefulSections.length) {
    return segments.map((item, index) => regionFrom(item, `${prefix}s${index}`, 'segment'));
  }
  const sectionRegions = usefulSections.map((item, index) => regionFrom(item, `${prefix}s${index}`, 'section'));
  // Section presence is not coverage completeness: complement file-backed
  // segment spans that no section covers, so executable mappings outside a
  // partial section table are never dropped.
  const covered = [];
  for (const r of sectionRegions) {
    if (r.size > 0n) covered.push([r.vmAddr, r.vmAddr + r.size]);
  }
  covered.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const merged = [];
  for (const iv of covered) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) {
      if (iv[1] > last[1]) last[1] = iv[1];
    } else {
      merged.push([iv[0], iv[1]]);
    }
  }
  const out = [...sectionRegions];
  let complementIndex = 0;
  for (const seg of segments) {
    let segAddr, segSize, segFileOff;
    try {
      segAddr = BigInt(seg.address ?? 0);
      segSize = BigInt(seg.fileSize ?? seg.size ?? 0);
      segFileOff = BigInt(seg.fileOffset ?? 0);
    } catch { continue; }
    if (segSize <= 0n) continue;
    let spans = [[segAddr, segAddr + segSize]];
    for (const [cs, ce] of merged) {
      for (let i = spans.length - 1; i >= 0; i--) {
        const [s, e] = spans[i];
        if (ce <= s || cs >= e) continue;
        spans.splice(i, 1);
        if (cs > s) spans.push([s, cs]);
        if (ce < e) spans.push([ce, e]);
      }
      if (!spans.length) break;
    }
    for (const [uStart, uEnd] of spans) {
      if (uEnd <= uStart) continue;
      const delta = uStart - segAddr;
      out.push(regionFrom({
        ...seg,
        address: uStart,
        fileOffset: segFileOff + delta,
        fileSize: uEnd - uStart,
        size: uEnd - uStart,
      }, `${prefix}x${complementIndex++}`, 'segment'));
    }
  }
  return out;
}

export function describeBinaryImage(image, options = {}) {
  const requestedEngine = options.engine || {};
  const engine = {
    ...DEPLOYED_CAPSTONE_SUPPORT,
    ...requestedEngine,
    verified: requestedEngine.verified === true,
  };
  const capability = architectureCapability(image, engine);
  const support = supportTruthForImage(image, { engine });
  const supportDisplay = supportDisplayForTruth(support);
  const regions = regionsForImage(image);
  const info = {
    cpu: image.arch || 'unknown',
    cpuSub: image.metadata?.subtypeName || (image.metadata?.subtypeBase == null ? 'all' : String(image.metadata.subtypeBase)),
    is64: image.bits === 64,
    isArm64: image.arch === 'arm64' || image.arch === 'arm64e',
    isArm64e: image.arch === 'arm64e',
    textVM: (regions.find((r) => r.exec)?.vmAddr ?? image.imageBase ?? 0n),
    encrypted: false,
    endian: image.endian,
    format: image.format,
    capability,
    support,
    supportDisplay,
  };
  const summary = image.summary();
  const formatMetadata = {
    format: image.format,
    arch: image.arch,
    bits: image.bits,
    endian: image.endian,
  };
  if (image.platform != null) formatMetadata.platform = image.platform;
  if (image.abi != null) formatMetadata.abi = image.abi;
  if (image.entrypoint != null) formatMetadata.entrypoint = image.entrypoint;
  if (image.imageBase != null) formatMetadata.imageBase = image.imageBase;
  if (image.metadata?.riscvIsa != null) formatMetadata.riscvIsa = image.metadata.riscvIsa;
  const productDescriptor = {
    formatId: image.format || 'raw',
    regions,
    dependencies: [...(image.libraries || [])],
    imports: [...(image.imports || [])],
    exports: [...(image.exports || [])],
    formatMetadata,
    support,
  };
  info.descriptor = productDescriptor;
  const raw = {
    id: 'raw', kind: 'file', name: 'Whole file (raw)', fileOffset: 0n, vmAddr: 0n,
    size: image.fileSize, declaredSize: image.fileSize, exec: false, write: false, read: true,
    zerofill: false, truncated: false,
  };
  return {
    name: options.name || 'binary',
    size: image.fileSize,
    format: displayFormat(image),
    formatId: image.format,
    slices: [{ name: image.arch || 'unknown', offset: image.fileOffset || 0n, size: image.fileSize, info, capability, support, supportDisplay, regions }],
    raw,
    productDescriptor,
    warnings: [...(image.warnings || [])],
    capability,
    support,
    supportDisplay,
    platform: {
      summary,
      sourceBacked: !!image.metadata?.sourceBacked,
      sourceReads: image.metadata?.sourceReads || null,
      metadataKeys: Object.keys(image.metadata || {}).sort(),
    },
  };
}