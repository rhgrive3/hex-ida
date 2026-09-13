import { ensureMachOMetadataBudget } from './macho-budget.js';
import { functionSeed, mergeFunctionSeeds } from './model.js';
import { resolveMachOPointer } from './macho-dyld.js';
import { machoInstructionUnit } from './macho-instruction-unit.js';
import { ByteView } from './reader.js';

const S_THREAD_LOCAL_INIT_FUNCTION_POINTERS = 0x15;

export function applyMachOTlvInitializers(thinInput, image) {
  const sections = (image.sections || []).filter((section) => (section.flags & 0xff) === S_THREAD_LOCAL_INIT_FUNCTION_POINTERS);
  if (!sections.length) return image;

  const budget = ensureMachOMetadataBudget(image);
  if (budget.stopped) return image;
  const r = new ByteView(thinInput, { littleEndian: image.endian !== 'big' });
  const ptrSize = image.bits === 64 ? 8 : image.bits === 32 ? 4 : 0;
  if (!ptrSize) {
    budget.partial('tlv-init:unsupported-pointer-width', `Unsupported Mach-O pointer width ${image.bits}`);
    return image;
  }

  const ptrSizeBig = BigInt(ptrSize);
  const arch = image.arch;
  // Keep TLV initializer promotion on the same shared ISA authority as
  // LC_ROUTINES. Unknown/unsupported architectures must not mint exact starts.
  const instructionBytes = machoInstructionUnit(arch);
  const recoveredTargets = new Set();
  const seeds = [];
  image.metadata.tlvInitializers ||= [];

  for (const section of sections) {
    if (section.size % ptrSizeBig !== 0n) {
      budget.partial(
        'tlv-init:truncated-section',
        `Mach-O section ${section.name} size ${section.size} is not a multiple of pointer width ${ptrSize}`,
      );
    }

    const countBig = section.size / ptrSizeBig;
    if (countBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      budget.partial('tlv-init:entry-count-invalid', `Mach-O section ${section.name} has too many TLV initializer entries`);
      continue;
    }
    const count = Number(countBig);
    const sectionFileOffset = section.fileOffset == null ? null : Number(section.fileOffset);
    const sectionFileSize = section.fileSize == null ? 0 : Number(section.fileSize);
    if (sectionFileOffset == null || !Number.isSafeInteger(sectionFileOffset) || sectionFileOffset < 0 || !Number.isSafeInteger(sectionFileSize) || sectionFileSize < 0) {
      budget.partial('tlv-init:file-range-invalid', `Mach-O section ${section.name} has an invalid file range`);
      continue;
    }

    const fileAvailable = sectionFileOffset <= r.length
      ? Math.max(0, Math.min(sectionFileSize, r.length - sectionFileOffset))
      : 0;
    const safeCount = Math.min(count, Math.floor(fileAvailable / ptrSize));
    if (safeCount < count) {
      budget.partial('tlv-init:file-truncated', `Mach-O section ${section.name} file data is truncated or zero-fill`);
    }

    for (let index = 0; index < safeCount; index++) {
      if (!budget.take({ inputBytes:ptrSize, records:1, objects:1, operations:1, estimatedHeapBytes:64 }, 'tlv-init')) return image;
      const slotAddress = section.address + BigInt(index * ptrSize);
      const slotOffset = sectionFileOffset + index * ptrSize;
      const raw = image.bits === 64 ? r.u64(slotOffset) : BigInt(r.u32(slotOffset));
      const target = resolveMachOPointer(image, raw, { address:slotAddress });

      let valid = false;
      let reason = null;
      if (target == null) {
        reason = 'unmapped-or-unresolved';
      } else {
        const targetSection = image.sectionAt(target);
        const targetSegment = image.segmentAt(target);
        const executable = Boolean(targetSection ? targetSection.perms?.execute : targetSegment?.perms?.execute);
        if (!executable) reason = 'non-executable';
        else if (instructionBytes == null) reason = 'unsupported-isa';
        else if (target % instructionBytes !== 0n) reason = 'misaligned';
        else {
          const first = image.addressToOffset(target);
          if (first == null) reason = 'not-file-backed';
          else {
            valid = true;
            for (let delta = 1n; delta < instructionBytes; delta++) {
              const offset = image.addressToOffset(target + delta);
              if (offset == null || offset !== first + delta) {
                valid = false;
                reason = 'not-file-backed';
                break;
              }
            }
          }
        }
      }

      image.metadata.tlvInitializers.push({
        address:target,
        raw,
        slotAddress,
        section:section.name,
        valid,
      });

      if (!valid) {
        budget.partial(
          `tlv-init:${reason}`,
          `Ignored Mach-O TLV initializer pointer at 0x${slotAddress.toString(16)} (raw 0x${raw.toString(16)}): ${reason}`,
        );
        continue;
      }

      const key = target.toString();
      if (recoveredTargets.has(key)) continue;
      recoveredTargets.add(key);
      seeds.push(functionSeed(target, {
        source:'constructor',
        confidence:0.95,
        exactFunctionStart:true,
        functionStartEvidence:'Mach-O S_THREAD_LOCAL_INIT_FUNCTION_POINTERS loader-invoked TLV initializer in validated executable mapping with file-backed instruction bytes',
        abiMetadata:{ machoLifecycle:'tlv-initializer' },
      }));
    }
  }

  if (seeds.length) {
    image.functions = mergeFunctionSeeds([...(image.functions || []), ...seeds], image);
    for (const fn of image.functions) {
      if (!recoveredTargets.has(fn.address.toString())) continue;
      fn.abiMetadata = { ...(fn.abiMetadata || {}), machoLifecycle:'tlv-initializer' };
    }
  }
  return image;
}
