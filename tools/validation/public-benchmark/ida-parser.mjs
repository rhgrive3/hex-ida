export function parseIdaFunctions(source) {
  if (typeof source !== 'string') throw new TypeError('ida-source-string-required');
  const marker = /\/\*\s*Function:\s*(.*?)\s*@\s*(0x[0-9A-Fa-f]+)\s*\*\//g;
  const found = [];
  let match;
  while ((match = marker.exec(source))) {
    found.push({ name:match[1].trim(), address:BigInt(match[2]), markerStart:match.index, bodyStart:marker.lastIndex });
  }
  return found.map((entry, index) => {
    const end = index + 1 < found.length ? found[index + 1].markerStart : source.length;
    const pseudocode = source.slice(entry.bodyStart, end).trim();
    return Object.freeze({ name:entry.name, address:entry.address, pseudocode });
  });
}
