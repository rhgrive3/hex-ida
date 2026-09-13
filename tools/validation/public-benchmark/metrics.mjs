function count(re, text) { return [...String(text ?? '').matchAll(re)].length; }
export function structuralReadabilityMetrics(code) {
  const text = String(code ?? '');
  const nonEmptyLines = text.split(/\r?\n/).filter(line => line.trim()).length;
  return Object.freeze({
    nonEmptyLines,
    gotoCount:count(/\bgoto\b/gi, text),
    castCount:count(/\([^()\n]*(?:\*|\b(?:u?int(?:8|16|32|64)_t|char|short|int|long|float|double|bool|size_t|__int\d+)\b)[^()\n]*\)/g, text),
    idaTempCount:new Set([...text.matchAll(/\bv\d+\b/g)].map(m => m[0])).size,
    hexLocalCount:new Set([...text.matchAll(/\blocal_[A-Za-z0-9_]+\b/g)].map(m => m[0])).size,
  });
}
