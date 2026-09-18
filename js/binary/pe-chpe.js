export function parseCHPELoadConfig(
  r,
  off,
  declared,
  image,
  budget,
  mappedFileRangeForRva,
  mappedFileSpanForRva,
) {
  if (image.metadata?._chpeParsed) return;
  image.metadata._chpeParsed = true;

  const targetImage = (Object.getPrototypeOf(image) && Object.getPrototypeOf(image).format === 'pe')
    ? Object.getPrototypeOf(image)
    : image;

  const is64 = image.bits === 64;
  // Offset of CHPEMetadataPointer: 200 (0xC8) in 64-bit, 140 or 124 in 32-bit
  const ptrSize = is64 ? 8 : 4;
  const chpeOffset = is64 ? 200 : (declared >= 144 ? 140 : 124);

  if (declared < chpeOffset + ptrSize) return;

  const chpePointerVa = is64
    ? BigInt(r.u32(off + chpeOffset)) | (BigInt(r.u32(off + chpeOffset + 4)) << 32n)
    : BigInt(r.u32(off + chpeOffset));

  if (chpePointerVa === 0n) return;

  // The presence of a non-zero CHPEMetadataPointer identifies this as a hybrid binary
  image.metadata.hybrid = true;
  image.metadata.isHybrid = true;
  image.metadata.chpe = true;
  image.arch = 'arm64ec';
  targetImage.arch = 'arm64ec';

  let chpeMetadataRva = null;
  if (image.imageBase != null && chpePointerVa >= image.imageBase && chpePointerVa - image.imageBase <= 0xffffffffn) {
    chpeMetadataRva = Number(chpePointerVa - image.imageBase);
  } else if (chpePointerVa > 0n && chpePointerVa <= 0xffffffffn) {
    chpeMetadataRva = Number(chpePointerVa);
  }

  const failClosed = (reason, msg) => {
    budget.partial(reason, msg);
    image.chpeCodeMap = [];
    targetImage.chpeCodeMap = [];
    image.metadata.loadConfig = {
      ...(image.metadata.loadConfig || {}),
      chpeMetadataPointer: chpePointerVa,
      chpeMetadata: null,
      chpeCodeMap: [],
      chpeCodeMapInvalid: true,
    };
  };

  if (chpeMetadataRva === null) {
    return failClosed('load-config:chpe-codemap-invalid', 'PE CHPE metadata pointer is outside mapped range');
  }

  // IMAGE_ARM64EC_METADATA requires at least 12 bytes: Version(4), CodeMap(4), CodeMapCount(4)
  const metaSpan = mappedFileSpanForRva(image, chpeMetadataRva, 12);
  if (!metaSpan) {
    return failClosed('load-config:chpe-codemap-invalid', 'PE CHPE metadata is not file-backed');
  }

  if (!budget.take({ inputBytes: 12, records: 1, objects: 1, operations: 1, estimatedHeapBytes: 128 }, 'chpe-metadata')) {
    return failClosed('load-config:chpe-codemap-invalid', 'PE CHPE metadata budget exceeded');
  }

  const metaOff = metaSpan.start;
  const version = r.u32(metaOff);
  const codeMapRva = r.u32(metaOff + 4);
  const codeMapCount = r.u32(metaOff + 8);

  if (!Number.isSafeInteger(codeMapCount) || codeMapCount <= 0 || codeMapCount > 0x100000 || !codeMapRva) {
    return failClosed('load-config:chpe-codemap-invalid', 'PE CHPE code map count or RVA is invalid');
  }

  const entrySize = 8;
  const totalCodeMapBytes = codeMapCount * entrySize;
  const codeMapSpan = mappedFileSpanForRva(image, codeMapRva, totalCodeMapBytes);
  if (!codeMapSpan) {
    return failClosed('load-config:chpe-codemap-invalid', 'PE CHPE code map table is not file-backed');
  }

  let previousEndRva = 0;
  const codeMapEntries = [];
  const archMap = {
    0: 'arm64',
    1: 'arm64ec',
    2: 'x86_64',
  };

  for (let i = 0; i < codeMapCount; i++) {
    if (!budget.take({ inputBytes: 8, records: 1, objects: 1, operations: 1, estimatedHeapBytes: 64 }, 'chpe-range-entry')) {
      return failClosed('load-config:chpe-codemap-invalid', 'PE CHPE range budget exceeded');
    }
    const entryOff = codeMapSpan.start + i * entrySize;
    const startOffset = r.u32(entryOff);
    const length = r.u32(entryOff + 4);

    const type = startOffset & 3;
    if (type !== 0 && type !== 1 && type !== 2) {
      return failClosed('load-config:chpe-codemap-invalid', `Invalid CHPE range type ${type}`);
    }

    const startRva = (startOffset & ~3) >>> 0;
    if (length <= 0) {
      return failClosed('load-config:chpe-codemap-invalid', 'PE CHPE range has non-positive length');
    }

    const endRva = startRva + length;
    if (!Number.isSafeInteger(endRva) || endRva > 0xffffffff) {
      return failClosed('load-config:chpe-codemap-invalid', 'PE CHPE range overflows 32-bit RVA space');
    }

    if (startRva < previousEndRva) {
      return failClosed('load-config:chpe-codemap-invalid', 'PE CHPE range entries are not monotonically non-overlapping');
    }
    previousEndRva = endRva;

    if (image.metadata?.sizeOfImage && endRva > image.metadata.sizeOfImage) {
      return failClosed('load-config:chpe-codemap-invalid', `PE CHPE range [0x${startRva.toString(16)}, 0x${endRva.toString(16)}) exceeds sizeOfImage`);
    }

    if (!mappedFileSpanForRva(image, startRva, length)) {
      return failClosed('load-config:chpe-codemap-invalid', `PE CHPE range [0x${startRva.toString(16)}, 0x${endRva.toString(16)}) is not fully file-backed`);
    }

    const arch = archMap[type];
    const startAddress = image.imageBase + BigInt(startRva);
    const endAddress = image.imageBase + BigInt(endRva);

    codeMapEntries.push({
      startRva,
      endRva,
      length,
      type,
      arch,
      startAddress,
      endAddress,
    });
  }

  image.chpeCodeMap = codeMapEntries;
  targetImage.chpeCodeMap = codeMapEntries;
  image.metadata.loadConfig = {
    ...(image.metadata.loadConfig || {}),
    chpeMetadataPointer: chpePointerVa,
    chpeMetadata: {
      version,
      codeMap: codeMapRva,
      codeMapCount,
    },
    chpeCodeMap: codeMapEntries,
  };

  const activeImage = targetImage || image;
  if (typeof activeImage.archAt === 'function') {
    for (const f of activeImage.functions || []) {
      if (f && f.address != null) {
        const a = activeImage.archAt(f.address);
        if (a) f.arch = a;
      }
    }
  }
}
