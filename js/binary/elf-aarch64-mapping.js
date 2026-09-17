import { markELFMetadataPartial } from './elf-budget.js';
import { sectionHasMappedAddress } from './model.js';

function mappingKind(name) {
  if (typeof name !== 'string') return null;
  const match = /^\$(x|d)(?:\..+)?$/.exec(name);
  return match?.[1] === 'x' ? 'instruction' : match?.[1] === 'd' ? 'data' : null;
}

function markPartial(image, reason, warning) {
  markELFMetadataPartial(image, reason, warning);
}

export function applyAarch64MappingSymbols(image) {
  if (image?.format !== 'elf' || image.arch !== 'arm64') return image;
  const executableSections = (image.sections || []).filter((section) =>
    section?.perms?.execute && sectionHasMappedAddress(section) && BigInt(section.size ?? 0) > 0n);
  const bySection = new Map(executableSections.map((section) => [section.index, section]));
  const mappings = [];
  for (const symbol of image.symbols || []) {
    const kind = mappingKind(symbol?.name);
    if (!kind) continue;
    // AAELF64 mapping symbols are local STT_NOTYPE zero-sized markers.
    if (symbol.binding !== 'local' || symbol.kind !== 'type-0' || BigInt(symbol.size ?? 0) !== 0n) continue;
    const section = bySection.get(symbol.sectionIndex);
    if (!section || symbol.address == null) {
      markPartial(image, 'aarch64-mapping-symbol-range', `ELF AArch64 mapping symbol ${symbol.name} is not inside a mapped executable section`);
      continue;
    }
    const start = BigInt(section.address), end = start + BigInt(section.size ?? 0), address = BigInt(symbol.address);
    if (address < start || address >= end) {
      markPartial(image, 'aarch64-mapping-symbol-range', `ELF AArch64 mapping symbol ${symbol.name} at 0x${address.toString(16)} is outside section ${section.index}`);
      continue;
    }
    if (address % 4n !== 0n) {
      markPartial(image, 'aarch64-mapping-symbol-alignment', `ELF AArch64 mapping symbol ${symbol.name} at 0x${address.toString(16)} is not 4-byte aligned`);
      continue;
    }
    mappings.push({ address, sectionIndex:section.index, kind, name:symbol.name, source:symbol.source });
  }
  mappings.sort((left, right) => left.sectionIndex - right.sectionIndex || (left.address < right.address ? -1 : left.address > right.address ? 1 : 0));
  const accepted = [];
  for (let i = 0; i < mappings.length;) {
    let j = i + 1;
    while (j < mappings.length && mappings[j].sectionIndex === mappings[i].sectionIndex && mappings[j].address === mappings[i].address) j++;
    const group = mappings.slice(i, j);
    if (new Set(group.map((entry) => entry.kind)).size !== 1) {
      markPartial(image, 'aarch64-mapping-symbol-conflict', `ELF AArch64 mapping symbols disagree at 0x${group[0].address.toString(16)}`);
    } else accepted.push(group[0]);
    i = j;
  }
  const sections = executableSections.map((section) => ({
    sectionIndex:section.index,
    start:BigInt(section.address),
    end:BigInt(section.address) + BigInt(section.size ?? 0),
  }));
  image.metadata.aarch64MappingSymbols = { mappings:accepted, sections, evidence:accepted.length ? 'mapping-symbol' : 'missing' };

  const grouped = new Map();
  for (const mapping of accepted) {
    let list = grouped.get(mapping.sectionIndex);
    if (!list) grouped.set(mapping.sectionIndex, list = []);
    list.push(mapping);
  }
  for (const [sectionIndex, list] of grouped) {
    const section = bySection.get(sectionIndex);
    if (!section) continue;
    const sectionEnd = BigInt(section.address) + BigInt(section.size ?? 0);
    for (let i = 0; i < list.length; i++) {
      if (list[i].kind !== 'data') continue;
      const start = list[i].address, end = i + 1 < list.length ? list[i + 1].address : sectionEnd;
      if (end <= start) continue;
      const length = end - start;
      const fileOffset = BigInt(section.fileOffset ?? 0) + (start - BigInt(section.address));
      if (length > BigInt(Number.MAX_SAFE_INTEGER) || fileOffset > BigInt(Number.MAX_SAFE_INTEGER)) {
        markPartial(image, 'aarch64-mapping-symbol-span', `ELF AArch64 mapping data span at 0x${start.toString(16)} is too large to publish`);
        continue;
      }
      image.addDataInCodeEntry({
        offset:Number(fileOffset), length:Number(length), kind:1,
        kindName:'ELF_AARCH64_MAPPING_DATA', address:start,
      });
    }
  }
  // Symbol/function discovery precedes this post-parse ABI overlay. Mapping data
  // may invalidate guessed starts, but exact starts carry independent authority
  // (symbols/exports/unwind/etc.) and must retain that provenance.
  if (image.dataInCode.length && Array.isArray(image.functions)) {
    image.functions = image.functions.filter((seed) =>
      seed?.address == null || seed.exactFunctionStart === true || !image.isDataInCode(seed.address));
  }
  return image;
}
