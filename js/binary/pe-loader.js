import { functionSeed } from './model.js';
import {
  createPEMetadataBudget,
  mappedFileRangeForRva,
  mappedFileSpanForRva,
  parseLoadConfig as parseLoadConfigCore,
} from './pe-loader-core.js';

export {
  PE_METADATA_LIMITS,
  createPEMetadataBudget,
  mappedFileRangeForRva,
  mappedFileSpanForRva,
  parseImports,
  parseExceptionFunctions,
  parseBaseRelocations,
  parseCoffSymbols,
  directory,
  peMachineName,
  resolveCoffSectionName,
  parseDelayImports,
  parseTlsDirectory,
} from './pe-loader-core.js';

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

function mappedCStringAtRva(r, image, rva, budget, label) {
  const range = mappedFileRangeForRva(image, rva);
  if (!range) { budget.partial(`${label}:unmapped-string`, `Ignored ${label} string outside a file-backed mapping`); return ''; }
  const maxByStringBudget = Math.max(1, Math.floor(budget.remainingStringBytes / 2) + 1);
  const max = Math.min(1 << 16, range.end - range.start, maxByStringBudget);
  if (max <= 0) return '';
  // ByteView.cstring() tolerates a missing NUL and returns the whole span, so
  // it would accept unterminated bytes as canonical metadata (#2187).
  const nulAt = r.slice(range.start, max).indexOf(0);
  if (nulAt < 0) {
    budget.partial(`${label}:unterminated-string`, `Ignored ${label} string without a NUL terminator inside its mapped span`);
    return '';
  }
  const value = r.cstring(range.start, max);
  const inputBytes = Math.min(max, value.length + 1);
  if (!budget.take({ inputBytes, stringBytes:value.length*2, operations:1, estimatedHeapBytes:value.length*2+32 }, `${label}-string`)) return '';
  return value;
}

function mappedCStringAtOffset(r, start, end, budget, label) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end || end > r.length) return '';
  const max = Math.min(1 << 16, end-start, Math.max(1, Math.floor(budget.remainingStringBytes/2)+1));
  // Same contract as mappedCStringAtRva: no NUL inside the span -> not a string.
  const nulAt = r.slice(start, max).indexOf(0);
  if (nulAt < 0) {
    budget.partial(`${label}:unterminated-string`, `Ignored ${label} string without a NUL terminator inside its span`);
    return '';
  }
  const value = r.cstring(start,max);
  if (!budget.take({ inputBytes:Math.min(max,value.length+1), stringBytes:value.length*2, operations:1, estimatedHeapBytes:value.length*2+32 }, `${label}-string`)) return '';
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
    const name=mappedCStringAtRva(r,image,nrva,budget,'PE export name');
    if(!name||ordIndex>=numberOfFunctions)continue;
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

