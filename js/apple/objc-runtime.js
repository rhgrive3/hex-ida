/* Objective-C runtime intelligence built on top of objc.js metadata parsing. */

const PROTOCOLS_KNOWN = Symbol('objc.protocolsKnown');

function cleanClassName(name) {
  if (name == null || typeof name !== 'string') return null;
  return name.replace(/^class\s+/, '').replace(/\s*\*+\s*$/, '').replace(/^@?"|"$/g, '').trim() || null;
}

function methodKey(classMethod, selector) {
  if (typeof selector !== 'string' || !selector) return null;
  return `${classMethod ? '+' : '-'}:${selector}`;
}

function canonicalAddressKey(value) {
  if (typeof value === 'bigint') return value >= 0n ? value.toString() : null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value).toString() : null;
  if (typeof value === 'string') {
    const s = value.trim();
    if (!/^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(s)) return null;
    try { return BigInt(s).toString(); } catch { return null; }
  }
  return null;
}

function pushIndex(map, key, value) {
  if (!key) return;
  let list = map.get(key);
  if (!list) { list = []; map.set(key, list); }
  list.push(value);
}

class ImmutableMap {
  #map;

  constructor(map) {
    this.#map = new Map(map);
    Object.freeze(this);
  }

  get size() {
    return this.#map.size;
  }

  get(key) {
    return this.#map.get(key);
  }

  has(key) {
    return this.#map.has(key);
  }

  entries() {
    return this.#map.entries();
  }

  keys() {
    return this.#map.keys();
  }

  values() {
    return this.#map.values();
  }

  [Symbol.iterator]() {
    return this.#map[Symbol.iterator]();
  }

  forEach(callback, thisArg) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    for (const [key, value] of this.#map) callback.call(thisArg, value, key, this);
  }

  set() {
    throw new TypeError('objc runtime index is immutable');
  }

  delete() {
    throw new TypeError('objc runtime index is immutable');
  }

  clear() {
    throw new TypeError('objc runtime index is immutable');
  }
}

// Preserve the established Map-compatible public surface without giving callers
// a real Map internal slot that intrinsic mutators can target.
Object.setPrototypeOf(ImmutableMap.prototype, Map.prototype);
Object.freeze(ImmutableMap.prototype);

function immutableMap(map) {
  return new ImmutableMap(map);
}

function immutableSnapshot(value, seen = new Map()) {
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);

  const copy = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) continue;
    Object.defineProperty(copy, key, {
      value: immutableSnapshot(descriptor.value, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return Object.freeze(copy);
}

function shallowCloneArray(value) {
  return Array.isArray(value)
    ? value.map((item) => item && typeof item === 'object' ? { ...item } : item)
    : value;
}

function freezeArray(value) {
  if (!Array.isArray(value)) return value;
  for (const item of value) {
    if (item && typeof item === 'object') Object.freeze(item);
  }
  return Object.freeze(value);
}

function freezeMethodEntries(map) {
  for (const entries of map.values()) {
    for (const entry of entries) {
      if (entry?.raw && typeof entry.raw === 'object') Object.freeze(entry.raw);
      Object.freeze(entry);
    }
    Object.freeze(entries);
  }
  return immutableMap(map);
}

function normalizeMethod(m, owner, classMethod, source = 'class', proofRequired = false) {
  if (!m) return null;
  let selector = null;
  if (typeof m.sel === 'string') selector = m.sel;
  else if (typeof m.selector === 'string') selector = m.selector;
  else if (typeof m.name === 'string') selector = m.name.match(/\s([^\]]+)\]$/)?.[1] || null;
  if (!selector) return null;
  const rawImp = proofRequired && source !== 'protocol' && source !== 'protocol-optional' && m?.implementationProven !== true
    ? null
    : (m.addr != null ? m.addr : (m.imp != null ? m.imp : null));
  return {
    selector,
    className: owner,
    classMethod: !!classMethod,
    imp: canonicalAddressKey(rawImp) == null ? null : rawImp,
    types: m.types || m.type || m.typeEncoding || null,
    typeEncoding: m.types || m.type || m.typeEncoding || null,
    source,
    optional: !!m.optional,
    raw: m && typeof m === 'object' ? { ...m } : m,
  };
}

/** Build immutable indices without changing the parser's original model. */
export function buildObjcRuntimeIndex(objcModel = {}) {
  const classes = new Map();
  const methodsBySelector = new Map();
  const protocolRequirementsBySelector = new Map();
  const methodsByIMP = new Map();
  const categories = [];
  const protocols = new Map();
  const proofRequired = objcModel.implementationProofRequired === true;

  for (const c of objcModel.classes || []) {
    if (!c) continue;
    const className = cleanClassName(c.name);
    if (!className) continue;
    const info = {
      ...c,
      name: className,
      superName: cleanClassName(c.superName),
      protocols: (c.protocols || []).map((p) => cleanClassName(p.name || p)).filter(Boolean),
    };
    info.methods = shallowCloneArray(info.methods);
    info.classMethods = shallowCloneArray(info.classMethods);
    Object.defineProperty(info, PROTOCOLS_KNOWN, { value: Array.isArray(c.protocols) });
    classes.set(info.name, info);
    for (const m of info.methods || []) {
      const x = normalizeMethod(m, info.name, false, 'class', proofRequired);
      if (!x) continue;
      pushIndex(methodsBySelector, methodKey(false, x.selector), x);
      const impKey = canonicalAddressKey(x.imp);
      if (impKey != null) pushIndex(methodsByIMP, impKey, x);
    }
    for (const m of info.classMethods || []) {
      const x = normalizeMethod(m, info.name, true, 'class', proofRequired);
      if (!x) continue;
      pushIndex(methodsBySelector, methodKey(true, x.selector), x);
      const impKey = canonicalAddressKey(x.imp);
      if (impKey != null) pushIndex(methodsByIMP, impKey, x);
    }
  }

  for (const p of objcModel.protocols || []) {
    if (!p) continue;
    const name = cleanClassName(p.name);
    if (!name) continue;
    const copy = { ...p, name, protocols: shallowCloneArray(p.protocols) };
    protocols.set(name, copy);
    for (const m of p.instanceMethods || p.methods || []) {
      const x = normalizeMethod({ ...m, optional: false }, name, false, 'protocol', proofRequired);
      if (x) pushIndex(protocolRequirementsBySelector, methodKey(false, x.selector), x);
    }
    for (const m of p.classMethods || []) {
      const x = normalizeMethod({ ...m, optional: false }, name, true, 'protocol', proofRequired);
      if (x) pushIndex(protocolRequirementsBySelector, methodKey(true, x.selector), x);
    }
    for (const m of p.optionalInstanceMethods || []) {
      const x = normalizeMethod({ ...m, optional: true }, name, false, 'protocol', proofRequired);
      if (x) pushIndex(protocolRequirementsBySelector, methodKey(false, x.selector), x);
    }
    for (const m of p.optionalClassMethods || []) {
      const x = normalizeMethod({ ...m, optional: true }, name, true, 'protocol', proofRequired);
      if (x) pushIndex(protocolRequirementsBySelector, methodKey(true, x.selector), x);
    }
  }

  for (const cat of objcModel.categories || []) {
    if (!cat) continue;
    const targetClass = cleanClassName(cat.className || cat.targetClass || cat.target);
    const name = cat.name || '(category)';
    const entry = { ...cat, name, targetClass };
    for (const field of ['protocols', 'methods', 'instanceMethods', 'classMethods']) {
      entry[field] = shallowCloneArray(entry[field]);
    }
    categories.push(entry);
    const target = targetClass ? classes.get(targetClass) : null;
    if (target && Array.isArray(cat.protocols) && cat.protocols.length) {
      target.protocols = [...new Set([...(target.protocols || []), ...cat.protocols.map((p) => cleanClassName(p?.name || p)).filter(Boolean)])];
    }
    for (const m of cat.instanceMethods || cat.methods || []) {
      const x = normalizeMethod(m, targetClass, false, 'category', proofRequired);
      if (x) {
        x.category = name;
        pushIndex(methodsBySelector, methodKey(false, x.selector), x);
        const impKey = canonicalAddressKey(x.imp);
        if (impKey != null) pushIndex(methodsByIMP, impKey, x);
      }
    }
    for (const m of cat.classMethods || []) {
      const x = normalizeMethod(m, targetClass, true, 'category', proofRequired);
      if (x) {
        x.category = name;
        pushIndex(methodsBySelector, methodKey(true, x.selector), x);
        const impKey = canonicalAddressKey(x.imp);
        if (impKey != null) pushIndex(methodsByIMP, impKey, x);
      }
    }
  }

  for (const info of classes.values()) {
    info.methods = freezeArray(info.methods);
    info.classMethods = freezeArray(info.classMethods);
    info.protocols = freezeArray(info.protocols);
    Object.freeze(info);
  }
  for (const info of protocols.values()) {
    info.protocols = freezeArray(info.protocols);
    Object.freeze(info);
  }
  for (const entry of categories) {
    for (const field of ['protocols', 'methods', 'instanceMethods', 'classMethods']) {
      entry[field] = freezeArray(entry[field]);
    }
    Object.freeze(entry);
  }

  const completeness = objcModel.runtimeCompleteness ? immutableSnapshot(objcModel.runtimeCompleteness) : null;
  return {
    runtime: 'objc',
    classes: immutableMap(classes),
    protocols: immutableMap(protocols),
    categories: Object.freeze(categories),
    methodsBySelector: freezeMethodEntries(methodsBySelector),
    protocolRequirementsBySelector: freezeMethodEntries(protocolRequirementsBySelector),
    methodsByIMP: freezeMethodEntries(methodsByIMP),
    completeness,
    selectorCount: methodsBySelector.size,
    methodCount: [...methodsBySelector.values()].reduce((n, a) => n + a.length, 0),
    protocolRequirementCount: [...protocolRequirementsBySelector.values()].reduce((n, a) => n + a.length, 0),
  };
}

function hierarchy(index, receiverType, budget = 64) {
  const out = [];
  let name = cleanClassName(receiverType);
  const seen = new Set();
  while (name && !seen.has(name) && out.length < budget) {
    seen.add(name);
    out.push(name);
    const c = index.classes.get(name);
    name = c ? cleanClassName(c.superName) : null;
  }
  return out;
}

// A hierarchy chain is a negative proof only when every link resolved to
// indexed class metadata and the walk reached a real root. A receiver class
// from a linked framework, bundle, or runtime registration is simply absent
// from the current image index: filtering by that open chain would turn an
// unobserved superclass into a proven contradiction.
function hierarchyComplete(index, chain) {
  if (!chain.length) return false;
  for (const name of chain) {
    if (!index.classes.has(name)) return false;
  }
  const last = index.classes.get(chain[chain.length - 1]);
  return !cleanClassName(last?.superName);
}

function protocolSet(index, chain, explicit) {
  const explicitProtocols = Array.isArray(explicit) ? explicit : [];
  const out = new Set(explicitProtocols.map((p) => cleanClassName(p?.name || p)).filter(Boolean));
  for (const name of chain) {
    const c = index.classes.get(name);
    for (const p of (c && c.protocols) || []) {
      const protocol = cleanClassName(p);
      if (protocol) out.add(protocol);
    }
  }
  const pending = [...out];
  while (pending.length) {
    const name = pending.pop();
    const protocol = index.protocols?.get(name);
    for (const inherited of protocol?.protocols || []) {
      const inheritedName = cleanClassName(inherited?.name || inherited);
      if (!inheritedName || out.has(inheritedName)) continue;
      out.add(inheritedName);
      pending.push(inheritedName);
    }
  }
  return out;
}

// A hierarchy chain is a negative proof only when every link resolved to
// indexed class metadata and the walk reached a real root. A receiver class
// from a linked framework, bundle, or runtime registration is simply absent
// from the current image index: filtering by that open chain would turn an
// unobserved superclass into a proven contradiction.
function hierarchyComplete(index, chain) {
  if (!chain.length) return false;
  for (const name of chain) {
    if (!index.classes.has(name)) return false;
  }
  const last = index.classes.get(chain[chain.length - 1]);
  return !cleanClassName(last?.superName);
}

// "Known-empty" protocol context must be distinguished from "unknown" context.
// An empty allowed set means unrestricted only when the receiver hierarchy or
// protocol universe itself is unknown; a known receiver that demonstrably
// adopts zero protocols must filter unrelated requirements to empty.
function protocolContextKnown(index, chain, explicit) {
  if (Array.isArray(explicit)) return true;
  if (!hierarchyComplete(index, chain)) return false;
  if (index.completeness?.classes?.complete === false) return false;
  if (index.completeness?.categories?.complete === false) return false;
  if (index.completeness?.protocols?.complete === false) return false;
  return chain.every((name) => index.classes.get(name)?.[PROTOCOLS_KNOWN] === true);
}

function protocolRequirements(index, key, allowedProtocols, contextKnown) {
  const all = index.protocolRequirementsBySelector?.get(key) || [];
  if (!allowedProtocols.size && !contextKnown) return all.slice();
  return all.filter((m) => allowedProtocols.has(m.className));
}

/**
 * Resolve an Objective-C message conservatively. If more than one target remains
 * plausible, all candidates are returned and `resolved` stays null. Protocol
 * method entries are requirements, not implementations, and are returned only
 * as separate evidence.
 */
export function resolveObjcDispatch(index, { receiverType = null, selector, classMethod = false, protocols = null } = {}) {
  if (!index || typeof selector !== 'string' || !selector) return { resolved: null, candidates: [], requirements: [], confidence: 0, reason: 'missing runtime index or selector' };
  const key = methodKey(classMethod, selector);
  const cleanReceiver = cleanClassName(receiverType);
  const chain = hierarchy(index, cleanReceiver);
  const ranks = new Map(chain.map((n, i) => [n, i]));
  const allowedProtocols = protocolSet(index, chain, protocols);
  const contextKnown = protocolContextKnown(index, chain, protocols);
  const requirements = protocolRequirements(index, key, allowedProtocols, contextKnown);
  const all = (index.methodsBySelector.get(key) || []).filter((m) => m.source !== 'protocol' && m.imp != null);
  if (!all.length) {
    return {
      resolved: null, candidates: [], requirements, confidence: requirements.length ? 0.35 : 0.1,
      receiverType: cleanReceiver, selector, classMethod: !!classMethod,
      reason: requirements.length ? 'protocol requirement present but implementation IMP is unknown' : 'selector implementation not present in parsed metadata',
    };
  }

  let candidates = all.map((m) => {
    let score = 0.25;
    let reason = m.source;
    if (m.source === 'category' && m.className && ranks.has(m.className)) { score = 0.91; reason = 'category on receiver hierarchy'; }
    else if (ranks.has(m.className)) { score = Math.max(0.6, 0.98 - ranks.get(m.className) * 0.08); reason = ranks.get(m.className) ? 'superclass method' : 'receiver class method'; }
    return { ...m, score, reason };
  });

  if (cleanReceiver) {
    const narrowed = candidates.filter((m) => ranks.has(m.className));
    if (!narrowed.length) {
      if (!hierarchyComplete(index, chain)) {
        return {
          resolved: null,
          candidates,
          requirements,
          confidence: 0,
          receiverType: cleanReceiver,
          selector,
          classMethod: !!classMethod,
          reason: 'receiver class hierarchy is unavailable or incomplete; selector candidates are inconclusive',
          partial: true,
        };
      }
      return {
        resolved: null,
        candidates: [],
        requirements,
        confidence: 0,
        receiverType: cleanReceiver,
        selector,
        classMethod: !!classMethod,
        reason: 'selector candidates contradict the explicit receiver type',
      };
    }
    // Objective-C lookup stops at the first class in the receiver hierarchy
    // that provides this selector. Implementations on deeper superclasses are
    // shadowed, not competing dispatch candidates. Keep every method at the
    // winning level so category collisions remain conservative.
    const nearestRank = Math.min(...narrowed.map((m) => ranks.get(m.className)));
    candidates = narrowed.filter((m) => ranks.get(m.className) === nearestRank);
  }
  candidates.sort((a, b) => b.score - a.score || String(a.className).localeCompare(String(b.className)));

  const top = candidates[0];
  const second = candidates[1];
  const topImpKey = top ? canonicalAddressKey(top.imp) : null;
  const sameImplementation = topImpKey != null && candidates.every((m) => canonicalAddressKey(m.imp) === topImpKey);
  const uniqueByEvidence = !!top && topImpKey != null && (!second || sameImplementation || (!cleanReceiver && top.score - second.score >= 0.16));
  const categoryComplete = index.completeness?.categories?.complete === true;
  // A complete scan of the current Mach-O image is not proof that every
  // Objective-C implementation available to the runtime has been indexed.
  // Without a proven receiver type, keep current-image hits as candidates
  // rather than turning local uniqueness into a process-wide exact target.
  const partialBlocksVerification = cleanReceiver ? !categoryComplete : true;
  const unambiguous = uniqueByEvidence && !partialBlocksVerification;
  return {
    resolved: unambiguous ? top : null,
    candidates,
    requirements,
    confidence: top ? top.score : 0,
    receiverType: cleanReceiver,
    selector,
    classMethod: !!classMethod,
    reason: unambiguous ? top.reason : (partialBlocksVerification
      ? (cleanReceiver
        ? 'Objective-C runtime metadata is partial; unseen category/implementation may change dispatch'
        : 'receiver type is unknown and the Objective-C runtime universe is open; current-image uniqueness is not a unique dispatch proof')
      : 'multiple plausible Objective-C implementations'),
    partial: partialBlocksVerification,
  };
}

export function formatObjcMessage({ receiver = 'receiver', selector, args = [], style = 'objc' } = {}) {
  const safeArgs = Array.isArray(args) ? args : [];
  if (typeof selector !== 'string' || !selector) return `unknown_call(${[receiver, ...safeArgs].join(', ')})`;
  if (style === 'dot') {
    const stem = selector.replace(/:/g, '_').replace(/_+$/, '');
    return `${receiver}.${stem}(${safeArgs.join(', ')})`;
  }
  const parts = String(selector).split(':');
  if (parts.length <= 1 || !selector.includes(':')) {
    const extra = safeArgs.length > 0 ? `, ${safeArgs.join(', ')}` : '';
    return `[${receiver} ${selector}${extra}]`;
  }
  let body = '';
  const paramCount = parts.length - 1;
  for (let i = 0; i < paramCount; i++) {
    if (i) body += ' ';
    body += `${parts[i]}:${safeArgs[i] != null ? safeArgs[i] : `a${i + 1}`}`;
  }
  if (safeArgs.length > paramCount) {
    body += `, ${safeArgs.slice(paramCount).join(', ')}`;
  }
  return `[${receiver} ${body}]`;
}

/** Convert objc_msgSend evidence into a semantic representation. */
export function objcMessage(index, { receiver, receiverType, selector, args = [], classMethod = false, protocols = null, style = 'objc' } = {}) {
  const safeArgs = Array.isArray(args) ? args : [];
  const dispatch = resolveObjcDispatch(index, { receiverType, selector, classMethod, protocols });
  return {
    runtime: 'objc', kind: 'message', receiver, receiverType: cleanClassName(receiverType), selector,
    args: safeArgs.slice(), dispatch,
    text: formatObjcMessage({ receiver: receiver || 'receiver', selector, args: safeArgs, style }),
    ambiguous: !dispatch.resolved && dispatch.candidates.length > 1,
  };
}

/**
 * Recognize a Block_layout from already-decoded fields. `fields` may be a Map or
 * an object keyed by byte offset. We require an invoke pointer; captures are kept
 * as evidence, never guessed into source variable names.
 */
export function recognizeObjcBlockLiteral(fields, opts = {}) {
  const get = (off) => fields instanceof Map ? fields.get(off) : fields && (fields[off] ?? fields['0x' + off.toString(16)]);
  const pointerSize = opts.pointerSize === 4 ? 4 : 8;
  const flagsOffset = pointerSize;
  const invokeOffset = pointerSize + 8;
  const descriptorOffset = invokeOffset + pointerSize;
  const capturesOffset = descriptorOffset + pointerSize;
  const isa = get(0), flags = get(flagsOffset), invoke = get(invokeOffset), descriptor = get(descriptorOffset);
  if (invoke == null) return null;
  const captures = [];
  const entries = fields instanceof Map ? [...fields.entries()] : Object.entries(fields || {}).map(([k, v]) => [Number(k), v]);
  for (const [rawOff, value] of entries) {
    const off = Number(rawOff);
    if (Number.isFinite(off) && off >= capturesOffset) captures.push({ offset: off, value });
  }
  captures.sort((a, b) => a.offset - b.offset);
  return {
    runtime: 'objc', kind: 'block', isa: isa ?? null, flags: flags ?? null,
    invoke, descriptor: descriptor ?? null, captures,
    text: `block(${captures.map((_, i) => `capture${i + 1}`).join(', ')})`,
    confidence: isa != null || descriptor != null ? 0.9 : 0.72,
    evidence: [`Block_layout invoke pointer at +0x${invokeOffset.toString(16)}`],
    address: opts.address ?? null,
  };
}

const ARC_NOISE = [
  /^_?objc_(retain|release|autorelease|retainAutoreleasedReturnValue|autoreleaseReturnValue|storeStrong|storeWeak|destroyWeak|initWeak|loadWeakRetained)\b/,
  /^_?_Block_(copy|release)\b/,
];

export function classifyObjcRuntimeCall(name) {
  const n = String(name || '');
  if (ARC_NOISE.some((r) => r.test(n))) return { runtime: 'objc', noise: true, category: 'ownership', name: n };
  if (/objc_msgSend/.test(n)) return { runtime: 'objc', noise: false, category: 'dispatch', name: n };
  if (/objc_(get|set)Property/.test(n)) return { runtime: 'objc', noise: false, category: 'property', name: n };
  return null;
}
