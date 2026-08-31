/* Modern Objective-C selector/message stub resolution. */

function selectorFromSymbol(name) {
  const n = typeof name === 'string' ? name : '';
  let m = n.match(/(?:^|_)objc_msgSend\$([^\s]+)$/);
  if (m) return m[1];
  m = n.match(/(?:^|_)objc_msgSend(?:_fixup)?[_$]([^\s]+)$/);
  if (m && m[1] && !/^(fixup|stub)$/.test(m[1])) return m[1];
  return null;
}

function selectorAddressKey(address) {
  if (typeof address === 'bigint') return address >= 0n ? address.toString() : null;
  if (typeof address === 'number') return Number.isSafeInteger(address) && address >= 0 ? address.toString() : null;
  if (typeof address !== 'string') return null;
  const text = address.trim();
  return /^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(text) ? text : null;
}

export function buildSelectorIndex({ selectorRefs = [], stubs = [], fixups = [] } = {}) {
  const byAddress = new Map();
  const bySelector = new Map();
  const add = (addr, selector, source, extra = {}) => {
    if (addr == null || !selector) return;
    const key = selectorAddressKey(addr);
    if (key == null) return;
    const entry = { addr, selector, source, ...extra };
    let at = byAddress.get(key); if (!at) { at = []; byAddress.set(key, at); }
    if (!at.some((x) => x.selector === selector && x.source === source)) at.push(entry);
    let ss = bySelector.get(selector); if (!ss) { ss = []; bySelector.set(selector, ss); }
    ss.push(entry);
  };

  for (const r of selectorRefs || []) add(r.addr ?? r.address, r.selector || r.sel || r.name, 'selector-ref', { raw: r });
  for (const s of stubs || []) {
    const selector = s.selector || s.sel || selectorFromSymbol(s.name);
    add(s.addr ?? s.address, selector, 'message-stub', { target: s.target ?? null, raw: s });
  }
  for (const f of fixups || []) {
    const selector = f.selector || f.sel || selectorFromSymbol(f.name);
    add(f.addr ?? f.address, selector, 'chained-fixup', { target: f.target ?? null, raw: f });
  }
  return { byAddress, bySelector, count: [...byAddress.values()].reduce((n, a) => n + a.length, 0) };
}

/**
 * Resolve a selector stub using every available source. A single candidate is
 * returned only when all evidence agrees; otherwise candidates remain explicit.
 */
export function resolveSelectorStub({ address, symbol = null, symbolFor = null, selectorIndex = null, selectorFor = null } = {}) {
  const candidates = [];
  const add = (selector, source, confidence) => {
    if (!selector) return;
    const old = candidates.find((c) => c.selector === selector);
    if (old) { old.confidence = Math.max(old.confidence, confidence); old.sources.push(source); }
    else candidates.push({ selector, confidence, sources: [source] });
  };
  const sym = symbol || (symbolFor && address != null ? symbolFor(address) : null);
  add(selectorFromSymbol(sym), 'stub symbol', 0.99);
  const addressKey = selectorAddressKey(address);
  if (selectorIndex && addressKey != null) {
    for (const e of selectorIndex.byAddress.get(addressKey) || []) add(e.selector, e.source, e.source === 'message-stub' ? 0.96 : 0.9);
  }
  if (selectorFor && address != null) add(selectorFor(address), 'selector resolver', 0.9);
  candidates.sort((a, b) => b.confidence - a.confidence || a.selector.localeCompare(b.selector));
  return {
    address: address ?? null,
    selector: candidates.length === 1 ? candidates[0].selector : null,
    candidates,
    ambiguous: candidates.length > 1,
    confidence: candidates[0]?.confidence || 0,
  };
}

export { selectorFromSymbol };
