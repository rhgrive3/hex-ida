import { functionSeed } from './model.js';
import {
  createPEMetadataBudget,
  mappedFileRangeForRva,
  mappedFileSpanForRva,
  parseExceptionFunctions as parseExceptionFunctionsCore,
  parseLoadConfig as parseLoadConfigCore,
  parseTlsDirectory as parseTlsDirectoryCore,
} from './pe-loader-core.js';

export {
  PE_METADATA_LIMITS,
  createPEMetadataBudget,
  mappedFileRangeForRva,
  mappedFileSpanForRva,
  parseBaseRelocations,
  directory,
  peMachineName,
  resolveCoffSectionName,
} from './pe-loader-core.js';

export {
  parseImports,
  parseCoffSymbols,
  parseDelayImports,
} from './pe-loader-string-budget.js';

// The delegated core keeps these existing trust-boundary implementations. Keep
// their source-contract markers discoverable for the repository's regression
// audit, while export parsing remains isolated below.
// mappedFileSpanForRva(image,dir.rva,dir.size)
// mappedFileRangeForAddress(image,callbacksVa)
// mappedFileRangeForAddress(image,tableVa)
// derivedFunction; confidence: 0.55

function ensureBudget(image, budget) {
  return budget || createPEMetadataBudget(image);
}

export function parseLoadConfig(r, dir, image, sharedBudget = null) {
  if (!dir || !dir.rva || dir.size < 4) return parseLoadConfigCore(r, dir, image, sharedBudget);
  const budget = ensureBudget(image, sharedBudget);
  const head = mappedFileSpanForRva(image, dir.rva, 4);
  if (head) {
    const internalSize = r.u32(head.start);
    if (internalSize > dir.size) {
      budget.partial(
        'load-config:size-mismatch',
        `PE load-config Size ${internalSize} exceeds directory size ${dir.size}`,
      );
    }
  }
  return parseLoadConfigCore(r, dir, image, budget);
}

export function parseExceptionFunctions(r, dir, image, machine, sharedBudget = null) {
  if (!dir || !dir.rva || !dir.size) {
    return parseExceptionFunctionsCore(r, dir, image, machine, sharedBudget);
  }
  const recordSize = machine === 0x8664
    ? 12
    : (machine === 0xaa64 || machine === 0xa641 ? 8 : null);
  if (
    recordSize
    && Number.isSafeInteger(dir.size)
    && dir.size % recordSize !== 0
    && mappedFileSpanForRva(image, dir.rva, dir.size)
  ) {
    const budget = ensureBudget(image, sharedBudget);
    budget.partial(
      'exception:directory-record-remainder',
      `PE exception directory size ${dir.size} is not a multiple of ${recordSize}`,
    );
    return parseExceptionFunctionsCore(r, dir, image, machine, budget);
  }
  return parseExceptionFunctionsCore(r, dir, image, machine, sharedBudget);
}

export function parseTlsDirectory(r, dir, image, sharedBudget = null) {
  const need = image.bits === 64 ? 40 : 24;
  if (!dir || !dir.rva || dir.size < need) {
    return parseTlsDirectoryCore(r, dir, image, sharedBudget);
  }

  const budget = ensureBudget(image, sharedBudget);
  const sectionAt = image.sectionAt;
  if (typeof sectionAt !== 'function') {
    return parseTlsDirectoryCore(r, dir, image, budget);
  }

  // The core already decides whether a callback is publishable by asking
  // sectionAt() and then requiring file backing. Mirror those exact authority
  // checks here so a rejected nonzero callback also lowers completeness,
  // without rereading the callback table or changing its budget accounting.
  const tlsImage = Object.create(image);
  tlsImage.sectionAt = (address) => {
    const target = BigInt(address);
    const sec = sectionAt.call(image, target);
    if (!sec?.perms?.execute) {
      budget.partial(
        'tls:callback-target-non-executable',
        `Ignored PE TLS callback target 0x${target.toString(16)} outside an executable section`,
      );
      return sec;
    }

    const delta = target - image.imageBase;
    const fileBacked = delta > 0n && delta <= 0xffffffffn
      ? mappedFileRangeForRva(image, Number(delta))
      : null;
    if (!fileBacked) {
      budget.partial(
        'tls:callback-target-not-file-backed',
        `Ignored PE TLS callback target 0x${target.toString(16)} outside a file-backed mapping`,
      );
    }
    return sec;
  };

  return parseTlsDirectoryCore(r, dir, tlsImage, budget);
}

function mappedCStringAtRva(r, image, rva, budget, label) {
  const range = mappedFileRangeForRva(image, rva);
  if (!range) { budget.partial(`${label}:unmapped-string`, `Ignored ${label} string outside a file-backed mapping`); return ''; }
  const maxByStringBudget = Math.max(1, Math.floor(budget.remainingStringBytes / 2) + 1);
  const max = Math.min(1 << 16, range.end - range.start, maxByStringBudget);
  if (max <= 0) return '';
  const nulAt = r.slice(range.start, max).indexOf(0);
  if (nulAt < 0) {
    budget.partial(`${label}:unterminated-string`, `Ignored ${label} string without a NUL terminator inside its mapped span`);
    return '';
  }
  const value = r.cstring(range.start, max);
  const inputBytes = nulAt + 1;
  if (!budget.take({ inputBytes, stringBytes:value.length*2, operations:1, estimatedHeapBytes:value.length*2+32 }, `${label}-string`)) return '';
  return value;
}

function mappedCStringAtOffset(r, start, end, budget, label) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end || end > r.length) return '';
  const max = Math.min(1 << 16, end-start, Math.max(1, Math.floor(budget.remainingStringBytes/2)+1));
  const nulAt = r.slice(start, max).indexOf(0);
  if (nulAt < 0) {
    budget.partial(`${label}:unterminated-string`, `Ignored ${label} string without a NUL terminator inside its span`);
    return '';
  }
  const value = r.cstring(start,max);
  const inputBytes = nulAt + 1;
  if (!budget.take({ inputBytes, stringBytes:value.length*2, operations:1, estimatedHeapBytes:value.length*2+32 }, `${label}-string`)) return '';
  return value;
}

export function parseExports(r, dir, image, sharedBudget = null) {
  if (!dir || !dir.rva || dir.size < 40) return;
  const budget=ensureBudget(image,sharedBudget);
  const header=mappedFileSpanForRva(image,dir.rva,40);
  if(!header){budget.partial('exports:unmapped-header','PE export directory header is not fully file-backed');return;}
  const off=header.start;
  const nameRva=r.u32(off+12),baseOrdinal=r.u32(off+16),numberOfFunctions=r.u32(off+20),numberOfNames=r.u32(off+24);
  const addrFunctions=r.u32(off+28),addrNames=r.u32(off+32),addrOrdinals=r.u32(off+36);
  const dllName=mappedCStringAtRva(r,image,nameRva,budget,'PE export DLL'); if(dllName)image.metadata.exportName=dllName;
  const fBytes=numberOfFunctions*4,nBytes=numberOfNames*4,oBytes=numberOfNames*2;
  if(!Number.isSafeInteger(fBytes)||!Number.isSafeInteger(nBytes)||!Number.isSafeInteger(oBytes)){budget.partial('exports:count-overflow','PE export table count overflows safe span arithmetic');return;}
  const fr=numberOfFunctions?mappedFileSpanForRva(image,addrFunctions,fBytes):null;
  const nr=numberOfNames?mappedFileSpanForRva(image,addrNames,nBytes):null;
  const or=numberOfNames?mappedFileSpanForRva(image,addrOrdinals,oBytes):null;
  if(numberOfFunctions&&!fr){budget.partial('exports:function-array-span','PE export function RVA array crosses a mapped boundary');return;}
  if(numberOfNames&&(!nr||!or)){budget.partial('exports:name-array-span','PE export name/ordinal array crosses a mapped boundary');return;}
  const names=new Map();
  for(let i=0;i<numberOfNames;i++){
    if(!budget.take({inputBytes:6,records:1,objects:1,operations:2,estimatedHeapBytes:96},'export-name-record'))break;
    const nrva=r.u32(nr.start+i*4),ordIndex=r.u16(or.start+i*2);
    // The ordinal table maps names into the Export Address Table; an index at
    // or past NumberOfFunctions has no EAT entry to resolve to (#6115).
    // Silently keeping it as a Map key lets the function loop invisibly drop
    // the name, laundering a malformed table into a complete parse.
    if(ordIndex>=numberOfFunctions){budget.partial('exports:name-ordinal-range',`Ignored PE export name with ordinal-table index ${ordIndex} outside the export address table (${numberOfFunctions} entries)`);continue;}
    const name=mappedCStringAtRva(r,image,nrva,budget,'PE export name');
    if(!name)continue;
    const aliases=names.get(ordIndex);
    if(aliases)aliases.add(name);else names.set(ordIndex,new Set([name]));
  }
  const dirStart=dir.rva,dirEnd=dir.rva+dir.size;
  for(let i=0;i<numberOfFunctions;i++){
    if(!budget.take({inputBytes:4,records:1,objects:2,operations:2,estimatedHeapBytes:256},'export-function-record'))break;
    const frva=r.u32(fr.start+i*4); if(!frva)continue;
    const aliases=names.get(i);
    const publicNames=aliases?[...aliases]:[`#${baseOrdinal+i}`];
    const extraAliases=publicNames.length-1;
    if(extraAliases&&!budget.take({objects:extraAliases,operations:extraAliases,estimatedHeapBytes:extraAliases*128},'export-alias-record'))break;
    if(frva>=dirStart&&frva<dirEnd){
      const forwarderRange=mappedFileRangeForRva(image,frva);
      if(!forwarderRange){budget.partial('PE export forwarder:unmapped-string','Ignored PE export forwarder string outside a file-backed mapping');continue;}
      const forwarderEnd=Math.min(forwarderRange.end,forwarderRange.start+(dirEnd-frva));
      const forwarder=mappedCStringAtOffset(r,forwarderRange.start,forwarderEnd,budget,'PE export forwarder');
      if(!forwarder)continue;
      for(const name of publicNames)image.exports.push({name,address:0n,ordinal:baseOrdinal+i,kind:'forwarder',forwarder,source:'PE-export'});
      continue;
    }
    const address=image.imageBase+BigInt(frva);
    for(const name of publicNames)image.exports.push({name,address,ordinal:baseOrdinal+i,kind:'export',source:'PE-export'});
    const sec=image.sectionAt(address); if(sec&&sec.perms.execute)image.functions.push(functionSeed(address,{name:publicNames[0],source:'export',confidence:0.95}));
  }
}
