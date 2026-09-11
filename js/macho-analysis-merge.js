const U64_MAX = 0xffffffffffffffffn;

function namesOf(result) {
  if (Array.isArray(result?.names)) return result.names;
  if (typeof result?.names === 'string') return result.names ? result.names.split('\n') : [];
  return [];
}

function addressValue(value) {
  let address;
  if (typeof value === 'bigint') address = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) address = BigInt(value);
  else if (typeof value === 'string' && /^(?:0|[1-9]\d*|0x[0-9a-f]+)$/i.test(value)) {
    try { address = BigInt(value); } catch { return null; }
  } else return null;
  return address >= 0n && address <= U64_MAX ? address : null;
}

function byteValue(value, fallback = 0) {
  if (value == null) return fallback;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xff ? value : null;
}

function nameValue(value) {
  if (value == null) return '';
  return typeof value === 'string' ? value : null;
}

function truthFallback(reason) {
  return { source:'BinaryImage', normalized:true, complete:false, reasons:[String(reason || 'normalized-macho-analysis-unavailable')] };
}

export function markMachOSymbolTruthIncomplete(result, reason) {
  return { ...result, symbolTruth: truthFallback(reason) };
}

export function mergeMachOAnalysisResults(legacy, normalized) {
  if (!legacy?.addrs) return normalized;
  if (!normalized?.addrs) return markMachOSymbolTruthIncomplete(legacy, 'normalized-macho-analysis-unavailable');
  const entries = new Map();
  let normalizedInvalid = false;
  const ingest = (result, authoritative) => {
    const names = namesOf(result);
    for (let i = 0; i < result.addrs.length; i++) {
      const addr = addressValue(result.addrs[i]);
      const name = nameValue(names[i]);
      const kind = byteValue(result.kinds?.[i]);
      const flag = byteValue(result.flags?.[i]);
      if (addr == null || name == null || kind == null || flag == null) {
        if (authoritative) normalizedInvalid = true;
        continue;
      }
      const key = addr.toString();
      const next = {
        addr, name, kind, flag, provenance:result.nameProvenance?.[i] || null,
      };
      const current = entries.get(key);
      if (!current) { entries.set(key, next); continue; }
      current.flag ||= next.flag;
      if (authoritative && next.name && (next.kind === 2 || !current.name || current.kind === 0)) {
        current.name = next.name; current.kind = next.kind; current.provenance = next.provenance;
      }
    }
  };
  ingest(legacy, false); ingest(normalized, true);
  const sorted = [...entries.values()].sort((a,b) => a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0);
  const addrs = new BigUint64Array(sorted.length), kinds = new Uint8Array(sorted.length), flags = new Uint8Array(sorted.length);
  for (let i = 0; i < sorted.length; i++) { addrs[i] = sorted[i].addr; kinds[i] = sorted[i].kind; flags[i] = sorted[i].flag; }
  return {
    ...legacy, addrs, kinds, flags, names:sorted.map((x)=>x.name), nameProvenance:sorted.map((x)=>x.provenance),
    symbolCount:sorted.length,
    symbolTruth:normalizedInvalid ? truthFallback('normalized-macho-symbol-record-invalid') : (normalized.symbolTruth || truthFallback('normalized-macho-completeness-unreported')),
    __transfer:[addrs.buffer, kinds.buffer, flags.buffer, legacy.funcs?.buffer].filter(Boolean),
  };
}
