// Resolve a declaring owner from existing RTTI and actual slot membership.
// This reads no code and never turns a qualified symbol alone into proof.
export function createPrimaryOwnerResolver(classes = []) {
  const byName = new Map(), byAddress = new Map();
  for (const record of classes) {
    for (const slot of record?.slots ?? []) {
      if (typeof slot.address !== 'bigint' || slot.unresolved) continue;
      const records = byAddress.get(slot.address) ?? new Set();
      records.add(record); byAddress.set(slot.address, records);
    }
    if (!record?.className || record.isSecondary || record.offsetToTop !== 0n) continue;
    const previous = byName.get(record.className);
    // Different primary identities with the same spelling are ambiguous.
    if (previous && previous.typeinfoAddress !== record.typeinfoAddress) byName.set(record.className, null);
    else if (!byName.has(record.className)) byName.set(record.className, record);
  }
  return (address, className, { maxNodes = 256 } = {}) => {
    if (typeof address !== 'bigint' || typeof className !== 'string' || !className
      || !Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 256) return null;
    const owner = byName.get(className), referencing = byAddress.get(address);
    if (!owner || typeof owner.typeinfoAddress !== 'bigint' || owner.typeinfoAddress <= 0n
      || !referencing?.has(owner)) return null;
    let visited = 0;
    const reachesOwner = (record, active = new Set()) => {
      if (++visited > maxNodes || !record || active.has(record.className)) return false;
      if (record.className === className) return record.typeinfoAddress === owner.typeinfoAddress;
      const path = new Set(active); path.add(record.className);
      const bases = record.resolvedBases ?? record.bases ?? [];
      if (bases.some(base => base.isVirtual !== false)) return false;
      const primary = bases.filter(base => base.offsetToTop === 0n);
      if (primary.length !== 1 || !primary[0].className) return false;
      const base = primary[0], target = byName.get(base.className);
      return Boolean(target && target.typeinfoAddress === base.typeinfoAddress && reachesOwner(target, path));
  };
  for (const record of referencing) {
    if (record.isSecondary || record.offsetToTop !== 0n || !reachesOwner(record)) return null;
  }
  return owner;
  };
}
