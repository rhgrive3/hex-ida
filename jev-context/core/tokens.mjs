/**
 * Deterministic, dependency-free token estimator.
 *
 * The engine never needs an exact tokenizer: it needs a stable, monotone
 * estimate that is good enough to (a) decide whether pruning should engage and
 * (b) report how much was removed. Latin text is ~4 chars/token; CJK is close
 * to 0.7 tokens/char. No locale or ICU dependency, so it behaves identically in
 * every process that loads the core.
 */
export function estimateTokens(input) {
  if (input === undefined || input === null) return 0;
  const text = typeof input === "string" ? input : String(input);
  if (text.length === 0) return 0;

  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const cp = char.codePointAt(0);
    const isCjk =
      (cp >= 0x3040 && cp <= 0x30ff) || // kana
      (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat
      (cp >= 0xff00 && cp <= 0xffef) || // fullwidth forms
      (cp >= 0x20000 && cp <= 0x2ebef); // CJK ext B-F
    if (isCjk) cjk += 1;
    else other += 1;
  }

  const estimate = cjk * 0.7 + other / 4;
  return Math.max(1, Math.ceil(estimate));
}

/** Sums the token estimate of a list of strings or context items. */
export function sumTokens(values) {
  let total = 0;
  for (const value of values) {
    if (value === undefined || value === null) continue;
    total += typeof value === "object" ? Number(value.tokens) || 0 : estimateTokens(value);
  }
  return total;
}
