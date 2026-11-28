function count(re, text) { return [...String(text ?? '').matchAll(re)].length; }

const PSEUDO_STACK_RE = /\b__hex_stack_frame\s*\[\s*\d+\s*\]|\bstack(?:_frame)?\s*\[\s*4096\s*\]/;
const STATE_MACHINE_RE = /\bswitch\s*\(\s*__hex_state\s*\)|\b__hex_state\b/;
const REGISTER_LEAK_RE = /\b(?:[xw](?:[0-9]|[12][0-9]|30)|sp|lr|fp|xzr|wzr|[vq](?:[0-9]|[12][0-9]|3[01])|r(?:[abcd]x|[sb]p|[sd]i|8|9|1[0-5])|e(?:[abcd]x|[sb]p|[sd]i))\b/;
const CAST_RE = /\([^()\n]*(?:\*|\b(?:u?int(?:8|16|32|64)_t|char|short|int|long|float|double|bool|size_t|__int\d+)\b)[^()\n]*\)/g;

function isBoilerplateLine(trimmed) {
  if (!trimmed) return true;
  if (trimmed.startsWith('#')) return true;
  if (trimmed.startsWith('//')) return true;
  if (/^\/\*.*\*\/$/.test(trimmed)) return true;
  if (/^typedef\b/.test(trimmed)) return true;
  return false;
}

export function structuralReadabilityMetrics(code) {
  const text = String(code ?? '');
  const lines = text.split(/\r?\n/);
  const nonEmptyLinesList = lines.map((line) => line.trim()).filter(Boolean);
  const nonEmptyLines = nonEmptyLinesList.length;
  const bodyLinesList = nonEmptyLinesList.filter((line) => !isBoilerplateLine(line));
  const effectiveLinesList = bodyLinesList.length ? bodyLinesList : nonEmptyLinesList;
  const bodyLines = effectiveLinesList.length;

  const castCount = count(CAST_RE, text);
  const hasPseudoStack = PSEUDO_STACK_RE.test(text);
  const hasStateMachine = STATE_MACHINE_RE.test(text);
  const registerLeakLines = effectiveLinesList.filter((line) => REGISTER_LEAK_RE.test(line)).length;
  const registerLeakRate = bodyLines > 0 ? registerLeakLines / bodyLines : 0;
  const castDensity = bodyLines > 0 ? castCount / bodyLines : 0;

  return Object.freeze({
    nonEmptyLines,
    gotoCount: count(/\bgoto\b/gi, text),
    castCount,
    idaTempCount: new Set([...text.matchAll(/\bv\d+\b/g)].map((m) => m[0])).size,
    hexLocalCount: new Set([...text.matchAll(/\blocal_[A-Za-z0-9_]+\b/g)].map((m) => m[0])).size,
    bodyLines,
    hasPseudoStack,
    hasStateMachine,
    registerLeakLines,
    registerLeakRate,
    castDensity,
  });
}
