import { ByteView } from './reader.js';

export const PT_GNU_PROPERTY = 0x6474e553;
export const NT_GNU_PROPERTY_TYPE_0 = 5;
export const GNU_PROPERTY_AARCH64_FEATURE_1_AND = 0xc0000000;
export const GNU_PROPERTY_AARCH64_FEATURE_1_BTI = 1;
export const GNU_PROPERTY_AARCH64_FEATURE_1_PAC = 2;
export const GNU_PROPERTY_AARCH64_FEATURE_1_GCS = 1 << 2;

const EM_AARCH64 = 183;
const PN_XNUM = 0xffff;
const DEFAULT_MAX_AGGREGATE_PROPERTY_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_PROPERTY_OPERATIONS = 262_144;
const DEFAULT_MAX_PROPERTY_ENTRIES = 65_536;
const DEFAULT_MAX_EVIDENCE_RECORDS = 4_096;

function safeNumber(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
}

function optionBudget(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function boundedSpan(offset, size, length) {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(size)
    && offset >= 0 && size >= 0 && offset <= length && size <= length - offset;
}

function budgetOption(options, primary, alias, fallback) {
  return optionBudget(options[primary] ?? options[alias], fallback);
}

function createPropertyBudget(options, maxProgramHeaders, maxPropertyBytes) {
  return {
    maxProgramHeaders,
    maxPropertyBytes,
    maxAggregatePropertyBytes: budgetOption(
      options,
      'maxAggregatePropertyBytes',
      'maxPropertyBytesTotal',
      DEFAULT_MAX_AGGREGATE_PROPERTY_BYTES,
    ),
    maxPropertyOperations: budgetOption(
      options,
      'maxPropertyOperations',
      'maxOperations',
      DEFAULT_MAX_PROPERTY_OPERATIONS,
    ),
    maxPropertyEntries: optionBudget(options.maxPropertyEntries, DEFAULT_MAX_PROPERTY_ENTRIES),
    maxEvidenceRecords: budgetOption(
      options,
      'maxEvidenceRecords',
      'maxEvidence',
      DEFAULT_MAX_EVIDENCE_RECORDS,
    ),
    programHeadersVisited: 0,
    uniqueSpans: 0,
    duplicateSpanHeaders: 0,
    aggregatePropertyBytes: 0,
    propertyOperations: 0,
    propertyEntries: 0,
    evidenceRecords: 0,
    exhausted: false,
    exhaustedReason: null,
  };
}

function budgetSnapshot(budget) {
  return Object.freeze({
    maxProgramHeaders: budget.maxProgramHeaders,
    maxPropertyBytes: budget.maxPropertyBytes,
    maxAggregatePropertyBytes: budget.maxAggregatePropertyBytes,
    maxPropertyOperations: budget.maxPropertyOperations,
    maxPropertyEntries: budget.maxPropertyEntries,
    maxEvidenceRecords: budget.maxEvidenceRecords,
    programHeadersVisited: budget.programHeadersVisited,
    uniqueSpans: budget.uniqueSpans,
    duplicateSpanHeaders: budget.duplicateSpanHeaders,
    aggregatePropertyBytes: budget.aggregatePropertyBytes,
    propertyOperations: budget.propertyOperations,
    propertyEntries: budget.propertyEntries,
    evidenceRecords: budget.evidenceRecords,
    exhausted: budget.exhausted,
    exhaustedReason: budget.exhaustedReason,
  });
}

function exhaustBudget(budget, reason) {
  if (!budget.exhausted) {
    budget.exhausted = true;
    budget.exhaustedReason = reason;
  }
  return false;
}

function takeOperation(budget) {
  if (budget.propertyOperations >= budget.maxPropertyOperations) {
    return exhaustBudget(budget, 'property-operations');
  }
  budget.propertyOperations++;
  return true;
}

function takePropertyEntry(budget) {
  if (budget.propertyEntries >= budget.maxPropertyEntries) {
    return exhaustBudget(budget, 'property-entries');
  }
  if (!takeOperation(budget)) return false;
  budget.propertyEntries++;
  return true;
}

function admitPropertySpan(budget, filesz) {
  if (filesz > budget.maxAggregatePropertyBytes - budget.aggregatePropertyBytes) {
    return exhaustBudget(budget, 'aggregate-property-bytes');
  }
  if (!takeOperation(budget)) return false;
  budget.aggregatePropertyBytes += filesz;
  budget.uniqueSpans++;
  return true;
}

function admitEvidenceRecord(budget) {
  if (budget.evidenceRecords >= budget.maxEvidenceRecords) {
    return exhaustBudget(budget, 'evidence-records');
  }
  budget.evidenceRecords++;
  return true;
}

function budgetResult(budget, overrides, warnings) {
  const finalWarnings = [...warnings];
  if (budget.exhausted) {
    finalWarnings.push(`GNU property parser budget exhausted: ${budget.exhaustedReason}`);
  }
  return defaultResult({
    ...overrides,
    budget: budgetSnapshot(budget),
    warnings: Object.freeze(finalWarnings),
  });
}


function defaultResult(overrides = {}) {
  return Object.freeze({
    kind:'gnu-property-aarch64-feature-1',
    loaderPolicy:'feature-bit-absent',
    btiRequested:false,
    pacRequested:false,
    gcsRequested:false,
    mappedPageGuarded:'unknown',
    mappedPageGuardedSource:'not-observed',
    evidence:Object.freeze([]),
    warnings:Object.freeze([]),
    ...overrides,
  });
}

/**
 * Parse only the bounded PT_GNU_PROPERTY / NT_GNU_PROPERTY_TYPE_0 data needed
 * for AArch64 FEATURE_1 evidence. This deliberately reports loader policy and
 * never upgrades it into actual mapped-page guarded state.
 */
export function parseAarch64GnuProperty(input, options = {}) {
  // ByteView accepts SparseByteBuffer-style `__binaryByteBacking` inputs
  // (#5006), so source-backed parses must reach this parser through the same
  // path instead of falling to `unavailable` on input type alone. Reads over
  // a sparse backing raise BINARY_SOURCE_RANGE_MISSING for uncached ranges,
  // which parseSourceRanges answers with a bounded refetch.
  let r = null;
  try {
    r = new ByteView(input, { littleEndian: true });
  } catch {
    return defaultResult({ loaderPolicy:'unavailable', btiRequested:null, pacRequested:null, gcsRequested:null, warnings:Object.freeze(['ELF bytes unavailable or truncated']) });
  }
  if (r.length < 64) return defaultResult({ loaderPolicy:'unavailable', btiRequested:null, pacRequested:null, gcsRequested:null, warnings:Object.freeze(['ELF bytes unavailable or truncated']) });
  if (r.u8(0) !== 0x7f || r.u8(1) !== 0x45 || r.u8(2) !== 0x4c || r.u8(3) !== 0x46) {
    return defaultResult({ loaderPolicy:'not-elf', btiRequested:null, pacRequested:null, gcsRequested:null });
  }
  const cls = r.u8(4);
  const data = r.u8(5);
  if ((cls !== 1 && cls !== 2) || (data !== 1 && data !== 2)) {
    return defaultResult({ loaderPolicy:'unsupported-elf-header', btiRequested:null, pacRequested:null, gcsRequested:null });
  }
  if (data !== 1) r = r.endian(false);
  const bits = cls === 2 ? 64 : 32;
  const machine = r.u16(18);
  if (machine !== EM_AARCH64) return defaultResult({ loaderPolicy:'not-aarch64', btiRequested:null, pacRequested:null, gcsRequested:null });
  const phoff = bits === 64 ? r.u64(32) : BigInt(r.u32(28));
  const phentsize = bits === 64 ? r.u16(54) : r.u16(42);
  let phnum = bits === 64 ? r.u16(56) : r.u16(44);
  const phoffNumber = safeNumber(phoff);
  const minPh = bits === 64 ? 56 : 32;
  const maxProgramHeaders = optionBudget(options.maxProgramHeaders, 4096);
  const maxPropertyBytes = optionBudget(options.maxPropertyBytes, 1024 * 1024);
  const budget = createPropertyBudget(options, maxProgramHeaders, maxPropertyBytes);
  const warnings = [];
  if (phnum === PN_XNUM) {
    warnings.push('extended ELF program-header count is not re-read by the bounded GNU property parser');
    return budgetResult(budget, { loaderPolicy:'unknown', btiRequested:null, pacRequested:null, gcsRequested:null }, warnings);
  }
  if (phoffNumber == null || phentsize < minPh || phnum > maxProgramHeaders
      || !boundedSpan(phoffNumber, phnum * phentsize, r.length)) {
    warnings.push('ELF program-header table is unavailable or outside bounded input');
    return budgetResult(budget, { loaderPolicy:'unknown', btiRequested:null, pacRequested:null, gcsRequested:null }, warnings);
  }

  const evidence = [];
  let featureBits = null;
  let propertyIncomplete = false;
  let propertyNonConforming = false;
  const admittedSpans = new Map();
  scanProgramHeaders: for (let index = 0; index < phnum; index++) {
    budget.programHeadersVisited++;
    if (!takeOperation(budget)) {
      propertyIncomplete = true;
      break;
    }
    const p = phoffNumber + index * phentsize;
    const type = r.u32(p);
    if (type !== PT_GNU_PROPERTY) continue;
    const offset = safeNumber(bits === 64 ? r.u64(p + 8) : BigInt(r.u32(p + 4)));
    const filesz = safeNumber(bits === 64 ? r.u64(p + 32) : BigInt(r.u32(p + 16)));
    if (offset == null || filesz == null || filesz > maxPropertyBytes
        || !boundedSpan(offset, filesz, r.length)) {
      propertyIncomplete = true;
      warnings.push(`PT_GNU_PROPERTY ${index} is outside bounded input`);
      continue;
    }
    // Loader policy for NT_GNU_PROPERTY_TYPE_0 requires the segment to be
    // aligned to the native address size (ELF32_GNU_PROPERTY_ALIGN=4,
    // ELF64_GNU_PROPERTY_ALIGN=8). glibc's _dl_process_pt_gnu_property skips
    // notes with any other p_align, so a nonconforming segment must never
    // mint BTI/PAC evidence (#4349).
    const requiredPropertyAlignment = bits === 64 ? 8 : 4;
    const segmentAlignmentRaw = bits === 64 ? r.u64(p + 48) : BigInt(r.u32(p + 28));
    const segmentAlignment = safeNumber(segmentAlignmentRaw);
    if (segmentAlignment !== requiredPropertyAlignment) {
      propertyNonConforming = true;
      warnings.push(`PT_GNU_PROPERTY ${index} is ignored: p_align ${segmentAlignmentRaw.toString()} does not satisfy the ${bits}-bit GNU property alignment ${requiredPropertyAlignment}`);
      continue;
    }
    const spanKey = `${offset}:${filesz}`;
    const admittedSpan = admittedSpans.get(spanKey);
    if (admittedSpan) {
      // Exact aliases carry no new property semantics. Keep the first
      // program-header index on each evidence record and do not rescan or
      // retain another copy for this alias.
      budget.duplicateSpanHeaders++;
      continue;
    }
    if (!admitPropertySpan(budget, filesz)) {
      propertyIncomplete = true;
      break;
    }
    const span = { offset, filesz, programHeaderIndex:index };
    admittedSpans.set(spanKey, span);
    const end = offset + filesz;
    let cursor = offset;
    while (cursor + 12 <= end) {
      if (!takePropertyEntry(budget)) {
        propertyIncomplete = true;
        break scanProgramHeaders;
      }
      const namesz = r.u32(cursor);
      const descsz = r.u32(cursor + 4);
      const noteType = r.u32(cursor + 8);
      const nameStart = cursor + 12;
      const descStart = align(nameStart + namesz, 4);
      const next = align(descStart + descsz, 4);
      if (!boundedSpan(nameStart, namesz, end) || !boundedSpan(descStart, descsz, end) || next <= cursor || next > end) {
        propertyIncomplete = true;
        warnings.push(`malformed GNU property note at file offset ${cursor}`);
        break;
      }
      const canonicalGnuOwner = namesz === 4
        && r.u8(nameStart) === 0x47
        && r.u8(nameStart + 1) === 0x4e
        && r.u8(nameStart + 2) === 0x55
        && r.u8(nameStart + 3) === 0x00;
      if (noteType === NT_GNU_PROPERTY_TYPE_0 && canonicalGnuOwner) {
        const propertyAlignment = bits === 64 ? 8 : 4;
        let propertyCursor = descStart;
        const descEnd = descStart + descsz;
        while (propertyCursor + 8 <= descEnd) {
          if (!takePropertyEntry(budget)) {
            propertyIncomplete = true;
            break scanProgramHeaders;
          }
          const propertyType = r.u32(propertyCursor);
          const dataSize = r.u32(propertyCursor + 4);
          const dataStart = propertyCursor + 8;
          if (!boundedSpan(dataStart, dataSize, descEnd)) {
            propertyIncomplete = true;
            warnings.push(`malformed GNU property payload at file offset ${propertyCursor}`);
            break;
          }
          if (propertyType === GNU_PROPERTY_AARCH64_FEATURE_1_AND) {
            if (dataSize !== 4) {
              propertyIncomplete = true;
              warnings.push(`malformed GNU_PROPERTY_AARCH64_FEATURE_1_AND size ${dataSize} at file offset ${propertyCursor}`);
            } else {
              if (!admitEvidenceRecord(budget)) {
                propertyIncomplete = true;
                break scanProgramHeaders;
              }
              const value = r.u32(dataStart);
              featureBits = featureBits == null ? value : (featureBits & value);
              evidence.push(Object.freeze({
                source:'PT_GNU_PROPERTY',
                programHeaderIndex:span.programHeaderIndex,
                noteType:NT_GNU_PROPERTY_TYPE_0,
                propertyType:GNU_PROPERTY_AARCH64_FEATURE_1_AND,
                fileOffset:propertyCursor,
                featureBits:value,
              }));
            }
          }
          const advanced = align(dataStart + dataSize, propertyAlignment);
          if (advanced <= propertyCursor || advanced > descEnd) {
            propertyIncomplete = true;
            break;
          }
          propertyCursor = advanced;
        }
        if (propertyCursor < descEnd) propertyIncomplete = true;
      }
      cursor = next;
    }
    if (cursor < end && cursor + 12 > end) {
      // Sub-4-byte trailing padding; must be zero to keep the note bounded.
      let zeroPadding = (end - cursor) < 4;
      for (let pad = cursor; zeroPadding && pad < end; pad++) {
        if (r.u8(pad) !== 0) zeroPadding = false;
      }
      if (!zeroPadding) {
        propertyIncomplete = true;
        warnings.push(`truncated GNU property note header at file offset ${cursor}`);
      }
    }
  }

  if (budget.exhausted) propertyIncomplete = true;
  if (propertyIncomplete) {
    return budgetResult(budget, {
      loaderPolicy:'unknown',
      btiRequested:null,
      pacRequested:null,
      gcsRequested:null,
      ...(featureBits == null ? {} : { featureBits }),
      evidence:Object.freeze(evidence),
    }, warnings);
  }
  if (propertyNonConforming && featureBits == null) {
    return budgetResult(budget, {
      loaderPolicy:'unknown',
      btiRequested:null,
      pacRequested:null,
      gcsRequested:null,
      evidence:Object.freeze(evidence),
    }, warnings);
  }
  if (featureBits == null) {
    return budgetResult(budget, {
      loaderPolicy:'feature-bit-absent',
      btiRequested:false,
      pacRequested:false,
      gcsRequested:false,
      evidence:Object.freeze(evidence),
    }, warnings);
  }
  const btiRequested = (featureBits & GNU_PROPERTY_AARCH64_FEATURE_1_BTI) !== 0;
  const pacRequested = (featureBits & GNU_PROPERTY_AARCH64_FEATURE_1_PAC) !== 0;
  const gcsRequested = (featureBits & GNU_PROPERTY_AARCH64_FEATURE_1_GCS) !== 0;
  return budgetResult(budget, {
    loaderPolicy:btiRequested ? 'bti-requested' : 'bti-not-requested',
    btiRequested,
    pacRequested,
    gcsRequested,
    featureBits,
    evidence:Object.freeze(evidence),
  }, warnings);
}

export function attachAarch64GnuPropertyEvidence(image, input, options = {}) {
  if (!image || image.format !== 'elf' || image.arch !== 'arm64') return image;
  const property = parseAarch64GnuProperty(input, options);
  image.metadata = image.metadata || {};
  image.metadata.arm64Bti = property;
  image.metadata.arm64GnuProperty = property;
  image.metadata.aarch64SecurityFeatures = Object.freeze({
    btiRequested: property.btiRequested,
    pacRequested: property.pacRequested,
    gcsRequested: property.gcsRequested,
    featureBits: property.featureBits,
    loaderPolicy: property.loaderPolicy,
    evidence: property.evidence,
  });
  for (const warning of property.warnings || []) image.warnings?.push?.(`AArch64 GNU property: ${warning}`);
  return image;
}