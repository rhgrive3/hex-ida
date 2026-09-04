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
  const usefulSections = sections.filter((s) => BigInt(s.fileSize ?? s.size ?? 0) > 0n || BigInt(s.size ?? 0n) > 0n);
  if (!usefulSections.length) {
    const segments = image.segments || [];
    return segments.map((item, index) => regionFrom(item, `${prefix}g${index}`, 'segment'));
  }

  const out = usefulSections.map((item, index) => regionFrom(item, `${prefix}s${index}`, 'section'));

  // Retain executable segment coverage not covered by mapped sections
  const segments = image.segments || [];
  for (let segIndex = 0; segIndex < segments.length; segIndex++) {
    const seg = segments[segIndex];
    const segStart = BigInt(seg.address ?? 0n);
    const segSize = BigInt(seg.size ?? seg.fileSize ?? 0n);
    if (segSize <= 0n || !seg.perms?.execute) continue;
    const segEnd = segStart + segSize;

    // Find mapped sections that overlap this segment
    const covering = usefulSections.filter((s) => {
      const sStart = BigInt(s.address ?? 0n);
      const sSize = BigInt(s.size ?? s.fileSize ?? 0n);
      const sEnd = sStart + sSize;
      const isMapped = !!(s.perms?.read || s.perms?.write || s.perms?.execute);
      return isMapped && sSize > 0n && sStart < segEnd && sEnd > segStart;
    }).map((s) => {
      const sStart = BigInt(s.address ?? 0n);
      const sSize = BigInt(s.size ?? s.fileSize ?? 0n);
      return {
        start: sStart < segStart ? segStart : sStart,
        end: (sStart + sSize) > segEnd ? segEnd : (sStart + sSize),
      };
    }).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

    // Find uncovered spans
    let cursor = segStart;
    const uncovered = [];
    for (const span of covering) {
      if (span.start > cursor) {
        uncovered.push({ start: cursor, end: span.start });
      }
      if (span.end > cursor) {
        cursor = span.end;
      }
    }
    if (cursor < segEnd) {
      uncovered.push({ start: cursor, end: segEnd });
    }

    uncovered.forEach((span, subIndex) => {
      const spanSize = span.end - span.start;
      if (spanSize <= 0n) return;
      const id = uncovered.length === 1 && span.start === segStart && spanSize === segSize
        ? `${prefix}g${segIndex}`
        : `${prefix}g${segIndex}_${subIndex}`;
      if (span.start === segStart && spanSize === segSize) {
        out.push(regionFrom(seg, id, 'segment'));
      } else {
        const offsetDelta = span.start - segStart;
        const segFileOffset = BigInt(seg.fileOffset ?? 0n);
        const segFileSize = BigInt(seg.fileSize ?? seg.size ?? 0n);
        const spanFileOffset = segFileOffset + offsetDelta;
        const remainingFileSize = segFileSize > offsetDelta ? segFileSize - offsetDelta : 0n;
        const spanFileSize = remainingFileSize > spanSize ? spanSize : remainingFileSize;
        out.push(regionFrom({
          name: seg.name ? `${seg.name} (uncovered)` : `Segment ${id}`,
          segment: seg.name || null,
          address: span.start,
          size: spanSize,
          fileOffset: spanFileOffset,
          fileSize: spanFileSize,
          perms: seg.perms,
          source: seg.source || 'segment',
        }, id, 'segment'));
      }
    });
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