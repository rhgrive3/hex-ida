import { functionSeed } from './model.js';
import { mappedFileSpanForRva } from './pe-loader-core.js';

const ARMNT_KIND = 'armnt-pdata';

function exceptionDirectoryMetadata(image) {
  const current = image.metadata.exceptionDirectory;
  if (!current || current.kind !== ARMNT_KIND) {
    image.metadata.exceptionDirectory = { count:0, kind:ARMNT_KIND, fragments:[], invalidRecords:0, records:[] };
  } else {
    current.fragments ||= [];
    current.invalidRecords ||= 0;
    current.records ||= [];
  }
  return image.metadata.exceptionDirectory;
}

function invalidExceptionRecord(image, budget, reason, warning) {
  exceptionDirectoryMetadata(image).invalidRecords++;
  budget.partial(`exception:${reason}`, warning);
  return null;
}

function executableRvaRange(image, beginRva, size = 1) {
  if (!Number.isInteger(beginRva) || beginRva <= 0 || !Number.isInteger(size) || size <= 0) return false;
  const begin = image.imageBase + BigInt(beginRva);
  const end = begin + BigInt(size);
  const section = image.sectionAt(begin);
  return !!(section?.perms?.execute && end <= section.address + section.size);
}

function parsePackedDescriptor(unwindData, image, begin, budget) {
  const flag = unwindData & 3;
  if (flag === 3) {
    return invalidExceptionRecord(image, budget, 'armnt-reserved-flag', `Ignored ARMNT exception entry with reserved packed flag at RVA 0x${begin.toString(16)}`);
  }
  if (flag === 0) return null;
  const functionLength = (unwindData >>> 2) & 0x7ff;
  if (!functionLength) {
    return invalidExceptionRecord(image, budget, 'armnt-packed-length', `Ignored zero-length ARMNT packed unwind entry at RVA 0x${begin.toString(16)}`);
  }
  const ret = (unwindData >>> 13) & 3;
  const reg = (unwindData >>> 16) & 7;
  const savesFloat = !!(unwindData & (1 << 19));
  const savesLr = !!(unwindData & (1 << 20));
  const chainsFrame = !!(unwindData & (1 << 21));
  if ((ret === 0 && !savesLr) || (chainsFrame && (!savesLr || (!savesFloat && reg === 7)))) {
    return invalidExceptionRecord(image, budget, 'armnt-packed-fields', `Ignored impossible ARMNT packed unwind fields at RVA 0x${begin.toString(16)}`);
  }
  return {
    size:functionLength * 2,
    fragment:flag === 2,
    encoding:flag === 2 ? 'packed-fragment' : 'packed',
  };
}

function parseXdataDescriptor(r, image, xdataRva, budget) {
  if (!xdataRva || (xdataRva & 3) !== 0) {
    return invalidExceptionRecord(image, budget, 'armnt-xdata-rva', `Ignored ARMNT exception entry with invalid .xdata RVA 0x${xdataRva.toString(16)}`);
  }
  const first = mappedFileSpanForRva(image, xdataRva, 4);
  if (!first || first.spanEnd > r.length) {
    return invalidExceptionRecord(image, budget, 'armnt-xdata-header', `Ignored ARMNT exception entry with unmapped/truncated .xdata RVA 0x${xdataRva.toString(16)}`);
  }
  if (!budget.take({ inputBytes:4, operations:1, estimatedHeapBytes:32 }, 'armnt-xdata-header')) return null;
  const header = r.u32(first.start);
  const functionLength = header & 0x3ffff;
  const version = (header >>> 18) & 3;
  const hasHandler = !!(header & (1 << 20));
  const packedEpilog = !!(header & (1 << 21));
  const fragment = !!(header & (1 << 22));
  let epilogCount = (header >>> 23) & 0x1f;
  let codeWords = (header >>> 28) & 0xf;
  let headerBytes = 4;
  if (version !== 0 || functionLength === 0) {
    return invalidExceptionRecord(image, budget, 'armnt-xdata-fields', `Ignored invalid ARMNT .xdata header at RVA 0x${xdataRva.toString(16)}`);
  }
  if (epilogCount === 0 && codeWords === 0) {
    const extension = mappedFileSpanForRva(image, xdataRva, 8);
    if (!extension || extension.spanEnd > r.length) {
      return invalidExceptionRecord(image, budget, 'armnt-xdata-extension', `Ignored truncated ARMNT .xdata extension at RVA 0x${xdataRva.toString(16)}`);
    }
    if (!budget.take({ inputBytes:4, operations:1 }, 'armnt-xdata-extension')) return null;
    const word = r.u32(extension.start + 4);
    if ((word >>> 24) !== 0) {
      return invalidExceptionRecord(image, budget, 'armnt-xdata-extension-reserved', `Ignored ARMNT .xdata extension with reserved bits at RVA 0x${xdataRva.toString(16)}`);
    }
    epilogCount = word & 0xffff;
    codeWords = (word >>> 16) & 0xff;
    headerBytes = 8;
  }
  const scopeWords = packedEpilog ? 0 : epilogCount;
  const recordBytes = headerBytes + scopeWords * 4 + codeWords * 4 + (hasHandler ? 4 : 0);
  if (!Number.isSafeInteger(recordBytes) || recordBytes < headerBytes) {
    return invalidExceptionRecord(image, budget, 'armnt-xdata-span', `Ignored oversized ARMNT .xdata record at RVA 0x${xdataRva.toString(16)}`);
  }
  const span = mappedFileSpanForRva(image, xdataRva, recordBytes);
  if (!span || span.spanEnd > r.length) {
    return invalidExceptionRecord(image, budget, 'armnt-xdata-span', `Ignored ARMNT .xdata record that crosses its file-backed mapping at RVA 0x${xdataRva.toString(16)}`);
  }
  const remainingBytes = recordBytes - headerBytes;
  if (remainingBytes > 0 && !budget.take({ inputBytes:remainingBytes, operations:Math.max(1, scopeWords + codeWords), estimatedHeapBytes:32 }, 'armnt-xdata-body')) return null;

  const functionBytes = functionLength * 2;
  if (!packedEpilog) {
    let previousScopeOffset = -1;
    for (let i = 0; i < epilogCount; i++) {
      const word = r.u32(span.start + headerBytes + i * 4);
      const startOffset = (word & 0x3ffff) * 2;
      const reserved = (word >>> 18) & 3;
      const codeIndex = (word >>> 24) & 0xff;
      if (reserved !== 0 || startOffset >= functionBytes || startOffset <= previousScopeOffset || codeIndex >= codeWords * 4) {
        return invalidExceptionRecord(image, budget, 'armnt-xdata-epilog-scope', `Ignored malformed ARMNT .xdata epilogue scope at RVA 0x${xdataRva.toString(16)}`);
      }
      previousScopeOffset = startOffset;
    }
  } else if (epilogCount >= codeWords * 4) {
    return invalidExceptionRecord(image, budget, 'armnt-xdata-epilog-index', `Ignored ARMNT .xdata packed epilogue index outside unwind codes at RVA 0x${xdataRva.toString(16)}`);
  }

  if (hasHandler) {
    const handlerOffset = span.start + headerBytes + scopeWords * 4 + codeWords * 4;
    const rawHandlerRva = r.u32(handlerOffset);
    const handlerRva = (rawHandlerRva & 0xfffffffe) >>> 0;
    const handlerSpan = mappedFileSpanForRva(image, handlerRva, 2);
    if (!handlerRva || !executableRvaRange(image, handlerRva, 2) || !handlerSpan || handlerSpan.spanEnd > r.length) {
      return invalidExceptionRecord(image, budget, 'armnt-xdata-handler', `Ignored ARMNT .xdata record with invalid exception handler RVA 0x${rawHandlerRva.toString(16)}`);
    }
  }

  return {
    size:functionBytes,
    fragment,
    encoding:fragment ? 'xdata-fragment' : 'xdata',
    xdataRva,
  };
}

export function parseArmntExceptionFunctions(r, dir, image, budget) {
  if (!dir || !dir.rva || !dir.size) return;
  if (Number.isSafeInteger(dir.size) && dir.size % 8 !== 0) return;
  const span = mappedFileSpanForRva(image, dir.rva, dir.size);
  if (!span) {
    budget.partial('exception:directory-span', 'PE exception directory crosses a mapped boundary');
    return;
  }
  const meta = exceptionDirectoryMetadata(image);
  let previousBegin = null;
  let previousEnd = null;
  let pendingZeroRecords = 0;
  for (let p = span.start; p + 8 <= span.spanEnd; p += 8) {
    if (p + 8 > r.length) {
      invalidExceptionRecord(image, budget, 'armnt-directory-truncated', 'Ignored truncated ARMNT .pdata record at end of file');
      break;
    }
    if (!budget.take({ inputBytes:8, records:1, objects:2, operations:3, estimatedHeapBytes:192 }, 'exception-record')) break;
    const rawBegin = r.u32(p);
    const unwindData = r.u32(p + 4);
    if (!rawBegin && !unwindData) { pendingZeroRecords++; continue; }
    if (pendingZeroRecords) {
      meta.invalidRecords += pendingZeroRecords;
      budget.partial('exception:internal-zero-record', `Ignored ${pendingZeroRecords} internal zero-filled ARMNT exception record(s) before a later record`);
      pendingZeroRecords = 0;
    }
    if (!rawBegin) {
      invalidExceptionRecord(image, budget, 'armnt-function-start', 'Ignored ARMNT exception entry with zero function start RVA');
      continue;
    }
    if ((rawBegin & 1) === 0) {
      invalidExceptionRecord(image, budget, 'armnt-thumb-state', `Ignored ARMNT exception entry without the required Thumb state bit at RVA 0x${rawBegin.toString(16)}`);
      continue;
    }
    const begin = (rawBegin & 0xfffffffe) >>> 0;
    if (!begin) {
      invalidExceptionRecord(image, budget, 'armnt-function-start', `Ignored ARMNT exception entry with invalid function start RVA 0x${rawBegin.toString(16)}`);
      continue;
    }
    if (previousBegin !== null && begin <= previousBegin) {
      invalidExceptionRecord(image, budget, 'armnt-order-overlap', `Ignored out-of-order ARMNT exception entry at RVA 0x${begin.toString(16)}`);
      continue;
    }
    previousBegin = begin;
    const descriptor = (unwindData & 3) === 0
      ? parseXdataDescriptor(r, image, unwindData >>> 0, budget)
      : parsePackedDescriptor(unwindData, image, begin, budget);
    if (!descriptor) continue;
    const size = descriptor.size;
    if (begin > 0xffffffff - size) {
      invalidExceptionRecord(image, budget, 'armnt-target-range', `Ignored ARMNT exception range overflowing the RVA domain at RVA 0x${begin.toString(16)}`);
      continue;
    }
    if (previousEnd !== null && begin < previousEnd) {
      invalidExceptionRecord(image, budget, 'armnt-order-overlap', `Ignored overlapping ARMNT exception range at RVA 0x${begin.toString(16)}`);
      continue;
    }
    if (!executableRvaRange(image, begin, size)) {
      invalidExceptionRecord(image, budget, 'armnt-target-range', `Ignored ARMNT exception range outside an executable section at RVA 0x${begin.toString(16)}`);
      continue;
    }
    const targetSpan = mappedFileSpanForRva(image, begin, size);
    if (!targetSpan || targetSpan.spanEnd > r.length) {
      invalidExceptionRecord(image, budget, 'armnt-target-file-span', `Ignored ARMNT exception range outside a complete file-backed mapping at RVA 0x${begin.toString(16)}`);
      continue;
    }
    const record = {
      rawBeginRva:rawBegin >>> 0,
      beginRva:begin,
      thumb:true,
      size,
      encoding:descriptor.encoding,
      fragment:!!descriptor.fragment,
      unwindRva:descriptor.xdataRva ?? null,
    };
    meta.records.push(record);
    if (descriptor.fragment) {
      meta.fragments.push({
        kind:'unwind-fragment',
        address:image.imageBase + BigInt(begin),
        size:BigInt(size),
        encoding:descriptor.encoding,
        xdataRva:descriptor.xdataRva ?? null,
        rawBeginRva:rawBegin >>> 0,
        thumb:true,
      });
    } else {
      image.functions.push(functionSeed(image.imageBase + BigInt(begin), { size:BigInt(size), source:'exception', confidence:0.995 }));
    }
    meta.count++;
    previousEnd = begin + size;
  }
}
