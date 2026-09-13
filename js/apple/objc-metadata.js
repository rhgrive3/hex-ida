/* Extended Objective-C runtime metadata. */
import { pagedReader, sanitizePointer, decodeMethodListHeader, resolveRelativeMethodSelectorAddress, resolveObjcPointerBytes } from '../objc-legacy.js';

const PTR = 8;
const NAME_READ_INITIAL = 256;
const NAME_READ_MAX = 8192;
const MAX_PROTOCOLS = 20000;
const MAX_CATEGORIES = 20000;
const MAX_METHODS = 60000;
const PROTOCOL_FIXED_SIZE = 72;
const PROTOCOL_CLASS_PROPERTIES_OFFSET = 88;
const PROTOCOL_CLASS_PROPERTIES_END = 96;

function u32(b, o = 0) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function i32(b, o = 0) { return u32(b, o) | 0; }
function u64(b, o = 0) { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]); return v; }

// Native pointer ABI for the extended (protocol/category) parser. The legacy
// parser owns the resolution so both surfaces cannot disagree (#8280).
function pointerBytesOf(get) { return get?.pointerBytes === 4 ? 4 : PTR; }
function readWord(get, buffer, offset) {
  return pointerBytesOf(get) === 4 ? BigInt(u32(buffer, offset)) : u64(buffer, offset);
}

// protocol_t / category_t layouts for a native pointer width. ILP32 keeps the
// same field order with 4-byte pointer fields (and 8-byte-aligned uint32 pairs
// collapse to their natural offset).
function protocolLayout(pointerBytes) {
  const ilp32 = pointerBytes === 4;
  return {
    pointerBytes,
    name:pointerBytes,
    protocols:pointerBytes * 2,
    instanceMethods:pointerBytes * 3,
    classMethods:pointerBytes * 4,
    optionalInstanceMethods:pointerBytes * 5,
    optionalClassMethods:pointerBytes * 6,
    instanceProperties:pointerBytes * 7,
    sizeField:pointerBytes * 8,
    classProperties:ilp32 ? 48 : 88,
    classPropertiesEnd:ilp32 ? 52 : 96,
    fixedSize:ilp32 ? 36 : 72,
    prefixReadBytes:ilp32 ? 32 : 64,
    prefixRequiredBytes:ilp32 ? 28 : 56,
    prefixCompleteBytes:ilp32 ? 32 : 64,
  };
}
function categoryLayout(pointerBytes) {
  const ilp32 = pointerBytes === 4;
  return {
    pointerBytes,
    name:0,
    cls:pointerBytes,
    instanceMethods:pointerBytes * 2,
    classMethods:pointerBytes * 3,
    protocols:pointerBytes * 4,
    instanceProperties:pointerBytes * 5,
    classProperties:pointerBytes * 6,
    readBytes:ilp32 ? 28 : 56,
    requiredBytes:ilp32 ? 24 : 48,
  };
}

async function decodedPointer(get, raw, storageAddress = null) {
  if (!raw) return null;
  if (typeof get.resolvePointer === 'function') {
    try {
      const resolved = await get.resolvePointer(raw, { address: storageAddress, imageBase: get.base });
      if (resolved == null) return null;
      return pointerTableAddress(resolved);
    } catch { return null; }
  }
  return sanitizePointer(raw, get.base);
}

async function ptr(get, addr) { const b = await get(addr, pointerBytesOf(get)); return b ? decodedPointer(get, readWord(get, b, 0), addr) : null; }

async function cstring(get, addr) {
  if (addr == null) return null;
  for (let want = NAME_READ_INITIAL; want <= NAME_READ_MAX; want *= 2) {
    const b = await get(addr, Math.min(want, NAME_READ_MAX), true);
    if (!b || !b.length) return null;
    const end = b.indexOf(0);
    if (end >= 0) {
      if (!end) return null;
      const bytes = b.subarray(0, end);
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return /[\u0000-\u001f\u007f]/u.test(text) ? null : text;
      } catch { return null; }
    }
    if (b.length < Math.min(want, NAME_READ_MAX) || want >= NAME_READ_MAX) return null;
  }
  return null;
}

function emptyListCompleteness(present = false) {
  return { present, declared: 0, scanned: 0, parsed: 0, capped: false, unreadableEntries: 0, invalidEntries: 0, complete: !present };
}

async function methodList(get, listAddr, owner, classMethod, source, opts = {}) {
  const items = [];
  if (listAddr == null) return { items, completeness: { ...emptyListCompleteness(false), complete: true } };
  if (opts?.signal?.aborted) return { items, completeness: { ...emptyListCompleteness(true), complete: false } };
  const h = await get(listAddr, 8);
  if (!h || h.length < 8) return { items, completeness: { ...emptyListCompleteness(true), unreadableEntries: 1, complete: false } };
  const rawEntsize = u32(h, 0), declared = u32(h, 4);
  if (!declared) return { items, completeness: { ...emptyListCompleteness(true), complete: !opts?.signal?.aborted } };
  if (declared > MAX_METHODS) {
    return { items, completeness: { present: true, declared, scanned: 0, parsed: 0, capped: true, unreadableEntries: 0, invalidEntries: 0, complete: false } };
  }
  const { relative, directSelector, stride } = decodeMethodListHeader(rawEntsize);
  const pointerBytes = pointerBytesOf(get);
  const entryWidth = relative ? 12 : pointerBytes * 3;
  if (stride < entryWidth) {
    return { items, completeness: { present: true, declared, scanned: 0, parsed: 0, capped: false, unreadableEntries: 0, invalidEntries: declared, complete: false } };
  }
  let scanned = 0, unreadableEntries = 0, invalidEntries = 0;
  for (let i = 0; i < declared; i++) {
    if (opts?.signal?.aborted) break;
    if ((i & 63) === 0 && i > 0) {
      await new Promise((r) => setTimeout(r, 0));
      if (opts?.signal?.aborted) break;
    }
    const at = listAddr + 8n + BigInt(i * stride);
    const b = await get(at, entryWidth);
    if (!b || b.length < entryWidth) { unreadableEntries++; break; }
    scanned++;
    let nameAddr = null, typeAddr = null, imp = null;
    if (relative) {
      const nameTarget = at + BigInt(i32(b, 0));
      nameAddr = await resolveRelativeMethodSelectorAddress(
        directSelector,
        nameTarget,
        (addr) => ptr(get, addr),
      );
      if (nameAddr == null) { invalidEntries++; continue; }
      typeAddr = at + 4n + BigInt(i32(b, 4)); imp = at + 8n + BigInt(i32(b, 8));
    } else {
      nameAddr = await decodedPointer(get, readWord(get, b, 0), at);
      typeAddr = await decodedPointer(get, readWord(get, b, pointerBytes), at + BigInt(pointerBytes));
      imp = await decodedPointer(get, readWord(get, b, pointerBytes * 2), at + BigInt(pointerBytes * 2));
    }
    const sel = await cstring(get, nameAddr);
    if (!sel) { invalidEntries++; continue; }
    const concrete=source!=='protocol'&&source!=='protocol-optional';let implementationProven=false,implementationValidationReason=null;
    if(concrete){if(imp!=null&&typeof get.validateImplementation==='function'){try{const proof=await get.validateImplementation(imp);implementationProven=proof===true||proof?.ok===true;if(!implementationProven)implementationValidationReason=proof?.reason||'method-imp-not-executable';}catch{implementationValidationReason='method-imp-validation-error';}}else if(imp!=null&&!get.requireImplementationProof)implementationProven=true;if(get.requireImplementationProof&&!implementationProven)invalidEntries++;}
    items.push({ sel, selector: sel, types: await cstring(get, typeAddr), addr: imp, imp, className: owner || null, classMethod: !!classMethod, source, kind: classMethod ? '+' : '-', name: owner ? `${classMethod ? '+' : '-'}[${owner} ${sel}]` : sel, implementationProven, implementationValidationReason });
  }
  return {
    items,
    completeness: {
      present: true,
      declared,
      scanned,
      parsed: items.length,
      capped: false,
      unreadableEntries,
      invalidEntries,
      complete: !opts?.signal?.aborted && unreadableEntries === 0 && invalidEntries === 0 && scanned === declared && items.length === declared,
    },
  };
}

async function protocolName(get, address) {
  if (address == null) return null;
  const pointerBytes = pointerBytesOf(get);
  const b = await get(address, pointerBytes * 2);
  if (!b) return null;
  return cstring(get, await decodedPointer(get, readWord(get, b, pointerBytes), address + BigInt(pointerBytes)));
}
async function protocolRefs(get, listAddr, opts = {}) {
  const items = [];
  if (listAddr == null) return { items, completeness: { ...emptyListCompleteness(false), complete: true } };
  if (opts?.signal?.aborted) return { items, completeness: { ...emptyListCompleteness(true), complete: false } };
  const pointerBytes = pointerBytesOf(get);
  const h = await get(listAddr, pointerBytes);
  if (!h || h.length < pointerBytes) return { items, completeness: { ...emptyListCompleteness(true), unreadableEntries: 1, complete: false } };
  const count64 = readWord(get, h, 0);
  if (count64 > 4096n) {
    return { items, completeness: { present: true, declared: count64 <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(count64) : null, scanned: 0, parsed: 0, capped: true, unreadableEntries: 0, invalidEntries: 0, complete: false } };
  }
  const declared = Number(count64);
  let scanned = 0, unreadableEntries = 0, invalidEntries = 0;
  for (let i = 0; i < declared; i++) {
    if (opts?.signal?.aborted) break;
    if ((i & 63) === 0 && i > 0) {
      await new Promise((r) => setTimeout(r, 0));
      if (opts?.signal?.aborted) break;
    }
    const slot = listAddr + BigInt(pointerBytes) + BigInt(i * pointerBytes);
    const raw = await get(slot, pointerBytes);
    if (!raw || raw.length < pointerBytes) { unreadableEntries++; continue; }
    scanned++;
    const address = await decodedPointer(get, readWord(get, raw, 0), slot);
    if (address == null) { invalidEntries++; continue; }
    const name = await protocolName(get, address);
    if (!name) { invalidEntries++; continue; }
    items.push({ name, address });
  }
  return {
    items,
    completeness: {
      present: true,
      declared,
      scanned,
      parsed: items.length,
      capped: false,
      unreadableEntries,
      invalidEntries,
      complete: !opts?.signal?.aborted && unreadableEntries === 0 && invalidEntries === 0 && scanned === declared && items.length === declared,
    },
  };
}

async function parseProtocol(get, address, opts = {}) {
  if (opts?.signal?.aborted) return null;
  const L = protocolLayout(pointerBytesOf(get));
  const b = await get(address, L.prefixReadBytes, true); if (!b || b.length < L.prefixRequiredBytes) return null;
  const sizeLayout = await get(address + BigInt(L.sizeField), 8, true);
  const sizeReadable = !!sizeLayout && sizeLayout.length >= 4;
  const flagsReadable = !!sizeLayout && sizeLayout.length >= 8;
  const size = sizeReadable ? u32(sizeLayout, 0) : null;
  const flags = flagsReadable ? u32(sizeLayout, 4) : null;
  const prefixComplete = b.length >= L.prefixCompleteBytes;
  let layoutComplete = flagsReadable && size >= L.fixedSize && prefixComplete;
  let classPropertiesAddress = null;
  const classPropertiesDeclared = size != null && size > L.classProperties;
  if (classPropertiesDeclared) {
    if (size < L.classPropertiesEnd) {
      layoutComplete = false;
    } else {
      const field = await get(address + BigInt(L.classProperties), L.pointerBytes, true);
      if (!field || field.length < L.pointerBytes) {
        layoutComplete = false;
      } else {
        const rawClassProperties = readWord(get, field, 0);
        classPropertiesAddress = await decodedPointer(get, rawClassProperties, address + BigInt(L.classProperties));
        if (rawClassProperties !== 0n && classPropertiesAddress == null) layoutComplete = false;
      }
    }
  }
  const fieldAddress = (offset) => decodedPointer(get, readWord(get, b, offset), address + BigInt(offset));
  const name = await cstring(get, await fieldAddress(L.name)); if (!name) return null;
  const inherited = await protocolRefs(get, await fieldAddress(L.protocols), opts);
  const methods = await methodList(get, await fieldAddress(L.instanceMethods), name, false, 'protocol', opts);
  const classMethods = await methodList(get, await fieldAddress(L.classMethods), name, true, 'protocol', opts);
  const optionalInstanceMethods = await methodList(get, await fieldAddress(L.optionalInstanceMethods), name, false, 'protocol-optional', opts);
  const optionalClassMethods = await methodList(get, await fieldAddress(L.optionalClassMethods), name, true, 'protocol-optional', opts);
  const methodCompleteness = {
    instanceMethods: methods.completeness,
    classMethods: classMethods.completeness,
    optionalInstanceMethods: optionalInstanceMethods.completeness,
    optionalClassMethods: optionalClassMethods.completeness,
  };
  const completeness = { methods: methodCompleteness, protocols: inherited.completeness, complete: !opts?.signal?.aborted && layoutComplete && inherited.completeness.complete && Object.values(methodCompleteness).every((x) => x.complete === true) };
  return { runtime: 'objc', kind: 'protocol', address, name, size, flags, protocols: inherited.items, methods: methods.items, instanceMethods: methods.items, classMethods: classMethods.items, optionalInstanceMethods: optionalInstanceMethods.items, optionalClassMethods: optionalClassMethods.items, instancePropertiesAddress: prefixComplete ? await fieldAddress(L.instanceProperties) : null, classPropertiesAddress, completeness };
}

function canonicalExternalClassName(name) {
  if (typeof name !== 'string') return null;
  const m = /^_OBJC_CLASS_\$_([A-Za-z_][A-Za-z0-9_]*)$/.exec(name);
  return m ? m[1] : null;
}

function classNameFromReference(value) {
  if (typeof value === 'string') {
    const canonical = canonicalExternalClassName(value);
    if (canonical) return canonical;
    const plain = value.trim();
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(plain) ? plain : null;
  }
  if (!value || typeof value !== 'object') return null;
  if (value.complete !== undefined && value.complete !== true) return null;
  if (value.completeness && typeof value.completeness === 'object'
    && value.completeness.complete !== undefined && value.completeness.complete !== true) return null;
  const candidate = value.className ?? value.targetClass ?? value.target ?? value.name;
  return typeof candidate === 'string' ? classNameFromReference(candidate) : null;
}

function classNameFromBinding(value) {
  const rawName = typeof value === 'string'
    ? value
    : value && typeof value === 'object'
      ? (value.name ?? value.symbol ?? value.import ?? null)
      : null;
  return canonicalExternalClassName(rawName);
}

async function resolveExternalCategoryClassName(get, storageAddress) {
  if (get == null || storageAddress == null) return null;
  if (typeof get.resolveClassReference === 'function') {
    try {
      const resolved = await get.resolveClassReference(storageAddress);
      const className = classNameFromReference(resolved);
      if (className) return className;
    } catch { /* fail closed */ }
  }
  const bindingAt = typeof get.bindingAt === 'function' ? get.bindingAt : null;
  if (!bindingAt) return null;
  let binding = null;
  try { binding = await bindingAt(storageAddress); } catch { return null; }
  if (!binding) return null;
  if (typeof binding === 'object' && binding.complete !== true) return null;
  return classNameFromBinding(binding);
}

function collectCategoryBindImports(sections, opts) {
  const out = [];
  for (const src of [opts?.binaryImage, sections?.binaryImage, opts, sections]) {
    const imports = src?.imports;
    if (Array.isArray(imports)) out.push(...imports);
  }
  return out;
}

function categoryBindImportsAreComplete(sections, opts) {
  for (const src of [opts?.binaryImage, sections?.binaryImage, opts, sections]) {
    const imports = src?.imports;
    if (!Array.isArray(imports) || imports.length === 0) continue;
    const chainedFixups = src?.metadata?.chainedFixups;
    if (!chainedFixups || typeof chainedFixups !== 'object'
      || chainedFixups.complete !== true
      || chainedFixups.importsComplete !== true
      || chainedFixups.bindingSitesComplete !== true) return false;
  }
  return true;
}

function buildBindingAtFromImports(imports) {
  const byAddress = new Map();
  for (const imp of imports) {
    if (!imp || typeof imp.name !== 'string' || !Array.isArray(imp.sites)) continue;
    for (const site of imp.sites) {
      try {
        if (site?.address == null) continue;
        const key = BigInt(site.address).toString();
        const binding = { name: imp.name, complete: true };
        if (!byAddress.has(key)) byAddress.set(key, binding);
        else if (byAddress.get(key)?.name !== imp.name) byAddress.set(key, null);
      } catch { /* ignore malformed site address */ }
    }
  }
  return (address) => {
    try { return byAddress.get(BigInt(address).toString()) || null; }
    catch { return null; }
  };
}

async function parseCategory(get, address, classByAddress, opts = {}) {
  if (opts?.signal?.aborted) return null;
  const L = categoryLayout(pointerBytesOf(get));
  const b = await get(address, L.readBytes, true); if (!b || b.length < L.requiredBytes) return null;
  const fieldAddress = (offset) => decodedPointer(get, readWord(get, b, offset), address + BigInt(offset));
  const name = await cstring(get, await fieldAddress(L.name)); if (!name) return null;
  const rawClassPointer = readWord(get, b, L.cls);
  const classAddress = await decodedPointer(get, rawClassPointer, address + BigInt(L.cls));
  const target = classAddress != null ? classByAddress.get(classAddress.toString()) : null;
  let className = target?.name || null;
  // Keep numeric pointer decoding fail-closed. Symbolic recovery is only
  // considered for a non-zero pointer that the numeric resolver identified as
  // an unresolved bind, never for an unknown ordinary address or null pointer.
  if (!className && classAddress == null && rawClassPointer !== 0n) {
    const external = await resolveExternalCategoryClassName(get, address + BigInt(L.cls));
    if (external) className = external;
  }
  const methods = await methodList(get, await fieldAddress(L.instanceMethods), className, false, 'category', opts);
  const classMethods = await methodList(get, await fieldAddress(L.classMethods), className, true, 'category', opts);
  const protocols = await protocolRefs(get, await fieldAddress(L.protocols), opts);
  const methodCompleteness = { instanceMethods: methods.completeness, classMethods: classMethods.completeness };
  const completeness = { methods: methodCompleteness, protocols: protocols.completeness, complete: !opts?.signal?.aborted && protocols.completeness.complete && Object.values(methodCompleteness).every((x) => x.complete === true) };
  return { runtime: 'objc', kind: 'category', address, name, classAddress, className, targetClass: className, target: className, methods: methods.items, instanceMethods: methods.items, classMethods: classMethods.items, protocols: protocols.items, instancePropertiesAddress: await fieldAddress(L.instanceProperties), classPropertiesAddress: b.length >= L.readBytes ? await fieldAddress(L.classProperties) : null, completeness };
}

function pointerTableSize(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return null;
}
function pointerTableAddress(value) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value.trim())) return BigInt(value.trim());
  return null;
}
function isCancellationError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}
async function pointerTable(get, range, budget, parse, opts = {}) {
  const items = [];
  if (!range) {
    return { items, completeness: { present: false, declared: 0, scanned: 0, parsed: 0, capped: false, unreadableSlots: 0, invalidEntries: 0, incompleteItems: 0, misalignedBytes: 0, sizeValid: true, complete: true } };
  }
  const size = pointerTableSize(range.size);
  const base = pointerTableAddress(range.vmAddr);
  if (size == null || base == null) {
    return { items, completeness: { present: true, declared: 0, scanned: 0, parsed: 0, capped: false, unreadableSlots: 0, invalidEntries: 1, incompleteItems: 0, misalignedBytes: null, sizeValid: false, complete: false } };
  }
  if (size === 0) {
    return { items, completeness: { present: false, declared: 0, scanned: 0, parsed: 0, capped: false, unreadableSlots: 0, invalidEntries: 0, incompleteItems: 0, misalignedBytes: 0, sizeValid: true, complete: true } };
  }
  const pointerBytes = pointerBytesOf(get);
  const sizeValid = true;
  const misalignedBytes = sizeValid ? size % pointerBytes : null;
  const declared = sizeValid ? Math.floor(size / pointerBytes) : 0;
  const count = Math.min(declared, budget);
  let scanned = 0, unreadableSlots = 0, invalidEntries = 0, incompleteItems = 0;
  for (let i = 0; i < count; i++) {
    if (opts?.signal?.aborted) break;
    if ((i & 63) === 0 && i > 0) {
      await new Promise((r) => setTimeout(r, 0));
      if (opts?.signal?.aborted) break;
    }
    const slot = base + BigInt(i * pointerBytes);
    const raw = await get(slot, pointerBytes);
    if (!raw || raw.length < pointerBytes) { unreadableSlots++; continue; }
    scanned++;
    const address = await decodedPointer(get, readWord(get, raw, 0), slot);
    if (address == null) { invalidEntries++; continue; }
    try {
      const item = await parse(address);
      if (item) {
        items.push(item);
        if (item.completeness?.complete === false) incompleteItems++;
      } else invalidEntries++;
    } catch (error) {
      if (isCancellationError(error)) throw error;
      invalidEntries++;
    }
  }
  const capped = declared > budget;
  const complete = sizeValid && misalignedBytes === 0 && !capped && unreadableSlots === 0 && invalidEntries === 0 && incompleteItems === 0 && items.length === scanned && scanned === declared && !opts?.signal?.aborted;
  return { items, completeness: { present: true, declared, scanned, parsed: items.length, capped, unreadableSlots, invalidEntries, incompleteItems, misalignedBytes, sizeValid, complete } };
}

export async function parseObjcExtendedMetadata(read, sections = {}, opts = {}) {
  const pointerAbi = resolveObjcPointerBytes(opts, sections);
  if (pointerAbi.bytes == null) {
    // A declared but unsupported pointer ABI must not be read as LP64 tables.
    const failedRange = (range) => ({
      present: !!range, declared: 0, scanned: 0, parsed: 0, capped: false,
      unreadableSlots: 0, invalidEntries: 1, incompleteItems: 0,
      misalignedBytes: null, sizeValid: false, complete: false,
    });
    return { runtime: 'objc', protocols: [], categories: [], pointerBytes: null,
      pointerAbiReason: pointerAbi.reason,
      completeness: {
        protocols: failedRange(sections?.protocolList),
        categories: failedRange(sections?.categoryList),
        complete: false,
      } };
  }
  const get = pagedReader(read, opts.pageBytes || 65536, opts.maxPages || 96, { signal: opts?.signal });
  get.pointerBytes = pointerAbi.bytes;
  get.base = opts.imageBase == null ? null : pointerTableAddress(opts.imageBase);
  get.resolvePointer = opts.resolvePointer || opts.binaryImage?.resolvePointer || opts.binaryImage?.decodePointer || null;
  get.validateImplementation = typeof opts.validateImplementation === 'function' ? opts.validateImplementation : null;
  get.requireImplementationProof = opts.requireImplementationProof === true;
  if (typeof opts.resolveClassReference === 'function') get.resolveClassReference = opts.resolveClassReference;
  else if (typeof sections?.resolveClassReference === 'function') get.resolveClassReference = sections.resolveClassReference;
  else if (typeof opts.binaryImage?.resolveClassReference === 'function') get.resolveClassReference = opts.binaryImage.resolveClassReference;
  else if (typeof sections?.binaryImage?.resolveClassReference === 'function') get.resolveClassReference = sections.binaryImage.resolveClassReference;
  if (typeof opts.bindingAt === 'function') get.bindingAt = opts.bindingAt;
  else if (typeof sections?.bindingAt === 'function') get.bindingAt = sections.bindingAt;
  else {
    const bindImports = collectCategoryBindImports(sections, opts);
    if (bindImports.length && categoryBindImportsAreComplete(sections, opts)) {
      get.bindingAt = buildBindingAtFromImports(bindImports);
    }
  }
  const classByAddress = new Map(
    (Array.isArray(opts.classes) ? opts.classes : [])
      .map((c) => [pointerTableAddress(c?.addr), c])
      .filter(([address]) => address != null)
      .map(([address, c]) => [address.toString(), c]),
  );
  const protocolTable = await pointerTable(get, sections.protocolList, MAX_PROTOCOLS, (address) => parseProtocol(get, address, opts), opts);
  const categoryTable = await pointerTable(get, sections.categoryList, MAX_CATEGORIES, (address) => parseCategory(get, address, classByAddress, opts), opts);
  const completeness = {
    protocols: protocolTable.completeness,
    categories: categoryTable.completeness,
    complete: !opts?.signal?.aborted && protocolTable.completeness.complete && categoryTable.completeness.complete,
  };
  return { runtime: 'objc', protocols: protocolTable.items, categories: categoryTable.items, pointerBytes: pointerAbi.bytes, completeness };
}

export { methodList, protocolRefs, parseProtocol, parseCategory };
