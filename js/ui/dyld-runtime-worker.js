import { openBinarySource } from '../binary/index.js';
import { mapDyldRuntimeAddress, normalizeDyldRuntimeAddress, normalizeDyldRuntimeSlide } from '../binary/dyld-runtime.js';

function summarize(image) {
  const metadata = image.metadata?.dyldSharedCache || {};
  const versions = new Set();
  let rebaseCount = 0;
  for (const mapping of metadata.mappingWithSlide || []) {
    const info = mapping?.slideInfo;
    if (Number.isSafeInteger(info?.version)) versions.add(info.version);
    if (Number.isSafeInteger(info?.rebaseCount)) rebaseCount += info.rebaseCount;
  }
  return {
    uuid:metadata.uuid || null,
    sharedRegionStart:metadata.sharedRegionStart == null ? null : String(metadata.sharedRegionStart),
    runtimeSharedRegionStart:metadata.runtimeSharedRegionStart == null ? null : String(metadata.runtimeSharedRegionStart),
    sharedRegionSize:metadata.sharedRegionSize == null ? null : String(metadata.sharedRegionSize),
    maxSlide:metadata.maxSlide == null ? null : String(metadata.maxSlide),
    slide:String(metadata.slide ?? 0n),
    slideInfoVersions:[...versions].sort((a, b) => a - b),
    rebaseCount,
  };
}

function serializeMapping(result) {
  if (!result.mapped) return { mapped:false, reason:result.reason, runtimeAddress:String(result.runtimeAddress), slide:String(result.slide) };
  return {
    mapped:true,
    runtimeAddress:String(result.runtimeAddress),
    unslidAddress:result.unslidAddress == null ? null : String(result.unslidAddress),
    fileOffset:String(result.fileOffset),
    slide:String(result.slide),
    segment:{ name:result.segment.name, address:String(result.segment.address), size:String(result.segment.size) },
    rebase:result.rebase ? {
      role:result.rebase.role,
      storageAddress:String(result.rebase.storageAddress),
      targetAddress:String(result.rebase.targetAddress),
      runtimeStorageAddress:String(result.rebase.runtimeStorageAddress),
      runtimeTargetAddress:String(result.rebase.runtimeTargetAddress),
      authenticated:result.rebase.authenticated,
    } : null,
  };
}

self.onmessage = async (event) => {
  const message = event.data || {};
  const id = message.id;
  try {
    const file = message.file;
    if (!file || !Number.isSafeInteger(file.size) || file.size <= 0) throw new TypeError('dyld runtime navigation requires an opened file');
    const slide = normalizeDyldRuntimeSlide(message.slide ?? 0n);
    const runtimeAddress = normalizeDyldRuntimeAddress(message.address);
    const image = await openBinarySource(file, { slide });
    if (image.format !== 'dyld-shared-cache') throw new TypeError('opened file is not a dyld shared cache');
    const result = mapDyldRuntimeAddress(image, runtimeAddress, slide);
    self.postMessage({ id, ok:true, result:serializeMapping(result), cache:summarize(image) });
  } catch (error) {
    self.postMessage({ id, ok:false, error:String(error?.message || error) });
  }
};
