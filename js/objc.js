/* Backward-compatible Objective-C metadata facade plus runtime dispatch intelligence. */
import { buildObjcModel as buildLegacyObjcModel, sanitizePointer } from './objc-legacy.js';
import { parseObjcExtendedMetadata } from './apple/objc-metadata.js';
import { buildObjcRuntimeIndex } from './apple/objc-runtime.js';

export * from './objc-legacy.js';
export { parseObjcExtendedMetadata } from './apple/objc-metadata.js';
export { buildObjcRuntimeIndex, resolveObjcDispatch, formatObjcMessage, objcMessage, recognizeObjcBlockLiteral, classifyObjcRuntimeCall } from './apple/objc-runtime.js';
export { buildSelectorIndex, resolveSelectorStub, selectorFromSymbol } from './apple/selector-stubs.js';

function createImplementationValidator(runtimeSections={},binaryImage=null){
  const ranges=(runtimeSections.executableRanges||[]).filter((r)=>r?.vmAddr!=null&&r?.size!=null&&r.size>0n);
  const arch=String(runtimeSections.architecture||binaryImage?.arch||'').toLowerCase();
  const alignment=arch.includes('arm64')?4n:(arch==='arm'||arch.startsWith('armv'))?2n:1n;
  return (address)=>{
    if(address==null)return{ok:false,reason:'method-imp-missing'};const a=BigInt(address);let executable=false;
    if(binaryImage&&typeof binaryImage.segmentAt==='function'){try{executable=binaryImage.segmentAt(a)?.perms?.execute===true;}catch{executable=false;}}
    if(!executable)executable=ranges.some((r)=>a>=BigInt(r.vmAddr)&&a<BigInt(r.vmAddr)+BigInt(r.size));
    if(!executable)return{ok:false,reason:'method-imp-not-executable'};
    if(alignment>1n&&a%alignment!==0n)return{ok:false,reason:'method-imp-misaligned'};
    return{ok:true};
  };
}

function categorySymbol(category, method, classMethod) {
  if (!method || method.imp == null || !method.selector || method.implementationProven !== true) return null;
  const owner = category.className || '<unknown>';
  const suffix = category.name ? `(${category.name})` : '';
  return {
    addr: method.imp,
    name: `${classMethod ? '+' : '-'}[${owner}${suffix} ${method.selector}]`,
    source: 'objc-category',
    types: method.types || method.type || method.typeEncoding || null,
  };
}

function categoryNames(categories = []) {
  const out = [];
  const seen = new Set();
  for (const category of categories) {
    for (const method of category.instanceMethods || category.methods || []) {
      const entry = categorySymbol(category, method, false);
      if (!entry) continue;
      const key = `${entry.addr}:${entry.name}`;
      if (!seen.has(key)) { seen.add(key); out.push(entry); }
    }
    for (const method of category.classMethods || []) {
      const entry = categorySymbol(category, method, true);
      if (!entry) continue;
      const key = `${entry.addr}:${entry.name}`;
      if (!seen.has(key)) { seen.add(key); out.push(entry); }
    }
  }
  return out;
}

/** Full Apple-runtime Objective-C model used by the App. */
export async function buildObjcRuntimeModel(read, classList, runtimeSections = {}, onProgress, imageBase, pointerFormat, options = {}) {
  const effectivePointerFormat = pointerFormat ?? classList?.pointerFormat ?? classList?.pointer_format ?? null;
  const binaryImage = runtimeSections?.binaryImage || null;
  const validateImplementation=createImplementationValidator(runtimeSections,binaryImage);
  const base = await buildLegacyObjcModel(read, classList, onProgress, imageBase, effectivePointerFormat, {
    validateImplementation,
    requireImplementationProof:true,
    signal: options?.signal || null,
    priority: options?.priority || 'idle',
    ...(options || {}),
  });
  let resolvePointer = typeof runtimeSections?.resolvePointer === 'function'
    ? runtimeSections.resolvePointer
    : null;
  if (!resolvePointer && binaryImage && typeof binaryImage.resolvePointer === 'function') {
    resolvePointer = (raw, context) => binaryImage.resolvePointer(raw, context);
  }
  if (!resolvePointer && binaryImage && typeof binaryImage.decodePointer === 'function') {
    resolvePointer = (raw, context) => binaryImage.decodePointer(raw, context);
  }
  // Preserve one pointer-decoding truth for the legacy + extended parsers.
  // The sanitizer fails closed for binds; a richer BinaryImage resolver wins
  // above when available (#2374).
  if (!resolvePointer && effectivePointerFormat != null) {
    resolvePointer = (raw, context = {}) => sanitizePointer(
      BigInt(raw),
      context.imageBase ?? imageBase ?? null,
      effectivePointerFormat,
    );
  }
  const extra = await parseObjcExtendedMetadata(read, runtimeSections, {
    imageBase,
    classes: base.classes || [],
    resolvePointer, validateImplementation, requireImplementationProof:true,
    signal: options?.signal || null,
    priority: options?.priority || 'idle',
    ...(options || {}),
  });
  const names = (base.names || []).filter((entry)=>entry?.implementationProven===true);
  const seen = new Set(names.map((entry) => `${entry.addr}:${entry.name}`));
  for (const entry of categoryNames(extra.categories)) {
    const key = `${entry.addr}:${entry.name}`;
    if (!seen.has(key)) { seen.add(key); names.push(entry); }
  }
  const legacyClasses = base.completeness?.classes || { present: !!classList, complete: false };
  const extended = extra.completeness || {};
  const runtimeCompleteness = {
    classes: legacyClasses,
    protocols: extended.protocols || { present: false, complete: true },
    categories: extended.categories || { present: false, complete: true },
  };
  runtimeCompleteness.complete = runtimeCompleteness.classes.complete === true
    && runtimeCompleteness.protocols.complete === true
    && runtimeCompleteness.categories.complete === true;
  const model = {
    ...base,
    names,
    protocols: extra.protocols || [],
    categories: extra.categories || [],
    runtimeCompleteness,
    runtime: 'objc',
    implementationProofRequired:true,
  };
  model.runtimeIndex = buildObjcRuntimeIndex(model);
  return model;
}
