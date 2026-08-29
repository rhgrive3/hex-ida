export function findingIdentity(item) {
  if (!item || typeof item !== 'object') return null;
  const value = item.id ?? item.findingId ?? item.goalId ?? item.goal?.id;
  if (value == null) return null;
  const id = String(value).trim();
  return id || null;
}

export function findingAddress(item) {
  if (!item || typeof item !== 'object') return null;
  return item.addr ?? item.address ?? item.functionAddr ?? item.function ?? null;
}

export function findFindingById(findings, id) {
  if (!Array.isArray(findings) || id == null) return null;
  const wanted = String(id);
  for (const item of findings) {
    if (findingIdentity(item) === wanted) return item;
  }
  return null;
}
