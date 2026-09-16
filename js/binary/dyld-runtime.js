const MAX_U64 = (1n << 64n) - 1n;

function exactU64(value, label) {
  let out;
  if (typeof value === 'bigint') out = value;
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be an exact integer`);
    out = BigInt(value);
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(text)) {
      throw new TypeError(`${label} must be hexadecimal (0x...) or decimal`);
    }
    out = BigInt(text);
  } else {
    throw new TypeError(`${label} must be an exact integer`);
  }
  if (out < 0n || out > MAX_U64) throw new RangeError(`${label} is outside the 64-bit address range`);
  return out;
}

/** Normalize a browser/API supplied dyld shared-cache runtime slide. */
export function normalizeDyldRuntimeSlide(value) {
  return exactU64(value, 'dyld runtime slide');
}

/** Normalize a runtime address copied from a crash log, debugger, or trace. */
export function normalizeDyldRuntimeAddress(value) {
  return exactU64(value, 'dyld runtime address');
}

/**
 * Translate one runtime address through an already slide-aware production
 * BinaryImage. The image's segment addresses are runtime addresses when it was
 * opened with `{ slide }`, so no duplicate dyld mapping rules live in the UI.
 */
export function mapDyldRuntimeAddress(image, value, slideValue = null) {
  if (!image || image.format !== 'dyld-shared-cache') throw new TypeError('dyld shared-cache BinaryImage required');
  const runtimeAddress = normalizeDyldRuntimeAddress(value);
  const metadata = image.metadata?.dyldSharedCache || {};
  const slide = normalizeDyldRuntimeSlide(slideValue ?? metadata.slide ?? 0n);
  const segment = (image.segments || []).find((entry) => {
    const start = BigInt(entry.address ?? 0n);
    const size = BigInt(entry.fileSize ?? entry.size ?? 0n);
    return size > 0n && runtimeAddress >= start && runtimeAddress < start + size;
  }) || null;
  if (!segment) return Object.freeze({ mapped:false, runtimeAddress, slide, reason:'runtime-address-unmapped' });

  const segmentAddress = BigInt(segment.address);
  const fileOffset = BigInt(segment.fileOffset ?? 0n) + (runtimeAddress - segmentAddress);
  const unslidAddress = runtimeAddress >= slide ? runtimeAddress - slide : null;
  let rebase = null;
  for (const mapping of metadata.mappingWithSlide || []) {
    for (const record of mapping?.slideInfo?.rebases || []) {
      if (record.runtimeStorageAddress === runtimeAddress) {
        rebase = { role:'storage', storageAddress:record.storageAddress, targetAddress:record.targetAddress,
          runtimeStorageAddress:record.runtimeStorageAddress, runtimeTargetAddress:record.runtimeTargetAddress,
          authenticated:record.authenticated === true };
        break;
      }
      if (record.runtimeTargetAddress === runtimeAddress) {
        rebase = { role:'target', storageAddress:record.storageAddress, targetAddress:record.targetAddress,
          runtimeStorageAddress:record.runtimeStorageAddress, runtimeTargetAddress:record.runtimeTargetAddress,
          authenticated:record.authenticated === true };
        break;
      }
    }
    if (rebase) break;
  }

  return Object.freeze({
    mapped:true,
    runtimeAddress,
    unslidAddress,
    fileOffset,
    slide,
    segment:Object.freeze({ name:segment.name || null, address:segmentAddress, size:BigInt(segment.size ?? segment.fileSize ?? 0n) }),
    rebase:rebase ? Object.freeze(rebase) : null,
  });
}
