/* Shared numeric search pattern helper (single owner for both search panels). */

export function numberPattern(text) {
  const t2 = text.trim().replace(/[_,]/g, '');
  let value;
  try {
    if (/^-?0x[0-9a-f]+$/i.test(t2)) {
      // Split the sign before BigInt: it parses unsigned '0x'/'0X' bodies but
      // rejects signed '-0x'/'-0X' forms, and a case-sensitive prefix strip
      // would accept '-0x1' while rejecting the equivalent '-0X1'.
      const negative = t2[0] === '-';
      value = BigInt(negative ? t2.slice(1) : t2) * (negative ? -1n : 1n);
    }
    else if (/^-?\d+$/.test(t2)) value = BigInt(t2);
    else return null;
  } catch { return null; }
  const wide = value < -0x80000000n || value > 0xFFFFFFFFn;
  const bytes = wide ? 8 : 4;
  const unsigned = BigInt.asUintN(bytes * 8, value);
  const out = [];
  for (let i = 0; i < bytes; i++) out.push(Number((unsigned >> BigInt(i * 8)) & 0xffn).toString(16).padStart(2, '0'));
  return out.join(' ');
}
