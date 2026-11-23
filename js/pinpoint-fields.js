import { isCxxMemberIndex, isCxxMemberField } from './analysis/cxx/member-index.js';

function validAddressKey(address) {
  if (typeof address === 'bigint') return address >= 0n ? address.toString() : null;
  if (typeof address === 'number') return Number.isSafeInteger(address) && address >= 0 ? BigInt(address).toString() : null;
  return null;
}

function buildCxxMethodOwners(cxxFields) {
  const byAddr = new Map();
  for (const cls of cxxFields.classes.values()) {
    if (!cls || cls.source !== 'cxx') continue;
    for (const iv of cls.ivars || []) {
      if (!isCxxMemberField(iv, cls)) continue;
      for (const prov of iv.provenance || []) {
        const key = validAddressKey(prov?.receiver?.functionAddress);
        if (key == null) continue;
        let list = byAddr.get(key);
        if (!list) {
          list = [];
          byAddr.set(key, list);
        }
        if (list.some((o) => o.ownerKey === cls.ownerKey)) continue;
        list.push({
          className: cls.name,
          sel: null,
          kind: 'cxx',
          accessorField: null,
          source: 'cxx',
          ownerKey: cls.ownerKey,
          classIdentity: cls.classIdentity,
        });
      }
    }
  }
  return byAddr;
}

// A projection of the same field universe used by deterministic Pinpoint.
// Reading this view never starts recovery or reads binary bytes.
export function composePinpointFields(fields, cxxFields) {
  if (!isCxxMemberIndex(cxxFields) || !cxxFields.fieldCount) return fields;
  if (fields === cxxFields) return fields;
  const classes = new Map(fields?.classes || []);
  const owners = new Set([...classes.values()].filter((cls) => cls?.source === 'cxx').map((cls) => cls.ownerKey));
  let added = 0;
  for (const [key, cls] of cxxFields.classes) {
    if (owners.has(cls.ownerKey) || !cls.ivars?.some((iv) => isCxxMemberField(iv, cls))) continue;
    classes.set(Symbol(key), cls);
    owners.add(cls.ownerKey);
    added += cls.ivars.length;
  }
  const cxxMethodOwners = buildCxxMethodOwners(cxxFields);
  const ownersOf = (address) => {
    const base = fields?.ownersOf?.(address) || [];
    const directCxx = typeof cxxFields.ownersOf === 'function' ? (cxxFields.ownersOf(address) || []) : [];
    const key = validAddressKey(address);
    const derivedCxx = key != null ? (cxxMethodOwners.get(key) || []) : [];
    if (!directCxx.length && !derivedCxx.length) return base;
    const out = base.slice();
    const seen = new Set(out.map((o) => o?.ownerKey || `${o?.className || ''}:${o?.sel || ''}:${o?.kind || ''}`));
    for (const o of [...directCxx, ...derivedCxx]) {
      const k = o?.ownerKey || `${o?.className || ''}:${o?.sel || ''}:${o?.kind || ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(o);
    }
    return out;
  };
  const ownerOf = (address) => {
    const combined = ownersOf(address);
    if (!combined.length) {
      return fields?.ownerOf?.(address) || (typeof cxxFields.ownerOf === 'function' ? cxxFields.ownerOf(address) : null) || null;
    }
    if (combined.length === 1) return combined[0];
    return { className: null, sel: null, kind: null, accessorField: null, ambiguous: true, owners: combined };
  };
  return {
    classes,
    classCount: classes.size,
    fieldCount: (fields?.fieldCount || 0) + added,
    classInfo: (name) => fields?.classInfo?.(name) || cxxFields.classInfo(name),
    ownerOf,
    ownersOf,
  };
}
