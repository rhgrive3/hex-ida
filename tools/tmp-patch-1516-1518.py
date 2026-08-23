from pathlib import Path
p=Path('js/binary/model.js'); s=p.read_text()
def rep(old,new,label):
 global s
 c=s.count(old)
 if c!=1: raise SystemExit(f'{label}: expected 1, found {c}')
 s=s.replace(old,new,1)
marker="""function bigintOrNull(v) {
  if (v == null) return null;
  return typeof v === 'bigint' ? v : BigInt(v);
}
"""
rep(marker,marker+"""
function strictBigIntOrNull(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  try { return BigInt(value.trim()); } catch { return null; }
}

function finiteConfidence(value, fallback = 0.5) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}
""",'helpers')
rep("  addressToOffset(address) {\n    const a = BigInt(address);\n","  addressToOffset(address) {\n    const a = strictBigIntOrNull(address);\n    if (a === null) return null;\n",'addressToOffset')
rep("  offsetToAddress(offset) {\n    const o = BigInt(offset);\n","  offsetToAddress(offset) {\n    const o = strictBigIntOrNull(offset);\n    if (o === null) return null;\n",'offsetToAddress')
rep("  sectionAt(address) {\n    const a = BigInt(address);\n","  sectionAt(address) {\n    const a = strictBigIntOrNull(address);\n    if (a === null) return null;\n",'sectionAt')
rep("  segmentAt(address) {\n    const a = BigInt(address);\n","  segmentAt(address) {\n    const a = strictBigIntOrNull(address);\n    if (a === null) return null;\n",'segmentAt')
rep("  resolveVirtualMapping(address) {\n    const a = (() => { try { return BigInt(address); } catch { return null; } })();\n","  resolveVirtualMapping(address) {\n    const a = strictBigIntOrNull(address);\n",'resolveVirtualMapping')
rep("""    try {
      current = BigInt(address);
      remaining = typeof size === 'bigint' ? size : BigInt(size);
    } catch {
      return null;
    }
""","""    current = strictBigIntOrNull(address);
    remaining = strictBigIntOrNull(size);
    if (current === null || remaining === null) return null;
""",'virtual read')
rep("        for (const [k, x] of Object.entries(v)) out[k] = convert(x);\n","        for (const [k, x] of Object.entries(v)) Object.defineProperty(out, k, { value: convert(x), enumerable: true, configurable: true, writable: true });\n",'json proto')
rep("  const confidence = Math.max(0, Math.min(1, Number(opts.confidence ?? 0.5)));\n","  const confidence = finiteConfidence(opts.confidence, 0.5);\n",'confidence')
rep("      : Math.max(0, Math.min(1, Number(opts.extentConfidence))),\n","      : finiteConfidence(opts.extentConfidence, 0.5),\n",'extent confidence')
rep("    const f = { ...f0, address: BigInt(f0.address) };\n","    const f = { ...f0, address: BigInt(f0.address), confidence: finiteConfidence(f0.confidence, 0.5), extentConfidence: f0.extentConfidence == null ? null : finiteConfidence(f0.extentConfidence, 0.5) };\n",'merge confidence')
p.write_text(s)
