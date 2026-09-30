import { isCxxMemberIndex, isCxxMemberField } from './analysis/cxx/member-index.js';

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
  return {
    classes,
    classCount: classes.size,
    fieldCount: (fields?.fieldCount || 0) + added,
    classInfo: (name) => fields?.classInfo?.(name) || cxxFields.classInfo(name),
    ownerOf: (address) => fields?.ownerOf?.(address) || null,
    ownersOf: (address) => fields?.ownersOf?.(address) || [],
  };
}
