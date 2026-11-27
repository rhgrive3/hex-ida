/* Formatting helpers. All addresses are BigInt — never Number. */
import { pick } from './i18n.js';

const HEX2 = new Array(256);
for (let i = 0; i < 256; i++) HEX2[i] = i.toString(16).toUpperCase().padStart(2, '0');

export { HEX2 };

/** 64-bit safe address → "10000C3B0" (uppercase, min 8 digits). */
export function addrText(v, pad = 8) {
  let s = (v < 0n ? -v : v).toString(16).toUpperCase();
  if (s.length < pad) s = s.padStart(pad, '0');
  return (v < 0n ? '-' : '') + s;
}

/** "0x10000C3B0" */
export function addrHex(v, pad = 8) {
  return v < 0n ? '-0x' + addrText(-v, pad) : '0x' + addrText(v, pad);
}

/** "F6 57 BD A9" or "F657BDA9" */
export function bytesHex(u8, off, len, spaced = true) {
  if (!u8 || typeof u8.length !== 'number') return '';
  const start = Math.max(0, Math.trunc(Number(off) || 0));
  const count = Math.max(0, Math.trunc(Number(len) || 0));
  const end = Math.min(u8.length, start + count);
  let s = '';
  for (let i = start; i < end; i++) {
    if (spaced && i > start) s += ' ';
    s += HEX2[u8[i]];
  }
  return s;
}

/** Printable ASCII rendering for hex mode. */
export function bytesAscii(u8, off, len) {
  if (!u8 || typeof u8.length !== 'number') return '';
  const start = Math.max(0, Math.trunc(Number(off) || 0));
  const count = Math.max(0, Math.trunc(Number(len) || 0));
  const end = Math.min(u8.length, start + count);
  let s = '';
  for (let i = start; i < end; i++) {
    const c = u8[i];
    s += (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : '.';
  }
  return s;
}

/** 24.7 MB */
export function sizeText(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '0' + pick(' バイト', ' bytes');
  if (v < 1024) return v + pick(' バイト', ' bytes');
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1, x = v;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return (x < 10 ? x.toFixed(2) : x < 100 ? x.toFixed(1) : Math.round(x)) + ' ' + units[i];
}

/**
 * Accepts "10000C448", "0x10000C448", "0X…", with separators/whitespace.
 * Decimal requires an explicit "d" suffix or "#" prefix (rare, but avoids
 * ambiguity). Returns BigInt or null.
 */
export function parseAddress(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim().replace(/[\s_,]/g, '');
  if (!s) return null;
  let neg = false;
  if (s[0] === '+') s = s.slice(1);
  else if (s[0] === '-') { neg = true; s = s.slice(1); }
  let v;
  try {
    if (/^#\d+$/.test(s)) v = BigInt(s.slice(1));
    else if (/^\d+d$/i.test(s)) v = BigInt(s.slice(0, -1));
    else if (/^0x[0-9a-f]+$/i.test(s)) v = BigInt(s);
    else if (/^[0-9a-f]+$/i.test(s)) v = BigInt('0x' + s);
    else return null;
  } catch { return null; }
  if (v < 0n) return null;
  return neg ? -v : v;
}

function toBigIntAddr(val) {
  if (typeof val === 'bigint') return val >= 0n ? val : null;
  if (typeof val === 'number' && Number.isSafeInteger(val) && val >= 0) return BigInt(val);
  if (typeof val === 'string') {
    const v = parseAddress(val);
    return v != null && v >= 0n ? v : null;
  }
  return null;
}

function parseOffsetTerm(text) {
  const s = String(text || '').trim().replace(/[\s_,]/g, '');
  if (!s) return null;
  try {
    if (/^0x[0-9a-f]+$/i.test(s)) return BigInt(s);
    if (/^#\d+$/.test(s)) return BigInt(s.slice(1));
    if (/^\d+d?$/i.test(s)) return BigInt(s.replace(/d$/i, ''));
  } catch { return null; }
  return null;
}

/**
 * Parse address arithmetic expressions such as "0x100040+0x10", "0x100040-16",
 * "main+0x10", or "sub_100040+8". Plain addresses delegate to parseAddress().
 */
export function parseAddressExpr(raw, resolveSymbol) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  if (!/^0x/i.test(s) && typeof resolveSymbol === 'function' && /[+-]/.test(s)) {
    try {
      const exactSym = toBigIntAddr(resolveSymbol(s));
      if (exactSym != null) return exactSym;
    } catch { /* fall through */ }
  }
  const expr = /^(.+?)\s*([+-])\s*([^+-]+)$/.exec(s);
  if (expr) {
    const baseRaw = expr[1].trim();
    const op = expr[2];
    const offset = parseOffsetTerm(expr[3]);
    if (baseRaw && offset != null) {
      let base = null;
      if (!/^0x/i.test(baseRaw) && typeof resolveSymbol === 'function') {
        try { base = toBigIntAddr(resolveSymbol(baseRaw)); } catch { base = null; }
      }
      if (base == null) {
        const parsedBase = parseAddress(baseRaw);
        if (parsedBase != null && parsedBase >= 0n) base = parsedBase;
      }
      if (base == null) {
        const subHit = /^sub_([0-9a-f]+)$/i.exec(baseRaw);
        if (subHit) {
          try { base = BigInt('0x' + subHit[1]); } catch { base = null; }
        }
      }
      if (base != null) {
        const result = op === '+' ? base + offset : base - offset;
        return result >= 0n ? result : null;
      }
    }
  }
  const plain = parseAddress(s);
  if (plain != null) return plain >= 0n ? plain : null;
  if (typeof resolveSymbol === 'function') {
    try { return toBigIntAddr(resolveSymbol(s)); } catch { return null; }
  }
  return null;
}

/**
 * Parse a hex byte pattern: "48 65 6C", "4865??6C", "0x48,0x65".
 * Returns {bytes: Uint8Array, mask: Uint8Array} or null.
 * "?" matches any nibble.
 */
export function parseHexPattern(text) {
  if (typeof text !== 'string') return null;
  // A prefix is syntax only at the beginning of a token.  Removing every
  // occurrence first would turn malformed input such as `10x2` into `12`.
  const s = text.replace(/(^|[\s,_-])0x(?=[0-9a-f?])/gi, '$1').replace(/[\s,_-]/g, '');
  if (!s.length || s.length % 2 !== 0) return null;
  if (!/^[0-9a-f?]+$/i.test(s)) return null;
  const n = s.length / 2;
  const bytes = new Uint8Array(n), mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const hi = s[i * 2], lo = s[i * 2 + 1];
    const m = (hi === '?' ? 0x00 : 0xf0) | (lo === '?' ? 0x00 : 0x0f);
    const b = ((hi === '?' ? 0 : parseInt(hi, 16)) << 4) | (lo === '?' ? 0 : parseInt(lo, 16));
    mask[i] = m;
    bytes[i] = b & m;
  }
  return { bytes, mask };
}

/** Control-flow mnemonics get a distinct color, like Hopper/IDA. */
const FLOW = new Set([
  // ARM64 control-flow
  'b', 'bl', 'blr', 'br', 'ret', 'cbz', 'cbnz', 'tbz', 'tbnz',
  'braa', 'brab', 'braaz', 'brabz', 'blraa', 'blrab', 'blraaz', 'blrabz',
  'retaa', 'retab', 'svc', 'brk', 'hlt', 'eret', 'eretaa', 'eretab', 'bti',
  // x86_64 control-flow
  'jmp', 'call', 'retn', 'retf',
  'je', 'jne', 'jz', 'jnz', 'ja', 'jae', 'jb', 'jbe', 'jna', 'jnae', 'jnb', 'jnbe',
  'jg', 'jge', 'jl', 'jle', 'jng', 'jnge', 'jnl', 'jnle',
  'jo', 'jno', 'js', 'jns', 'jp', 'jnp', 'jpe', 'jpo',
  'jcxz', 'jecxz', 'jrcxz',
]);

const ARM64_CONDITIONAL_BRANCH = /^b\.(?:eq|ne|cs|hs|cc|lo|mi|pl|vs|vc|hi|ls|ge|lt|gt|le|al|nv)$/;

export function mnemonicClass(mn) {
  if (!mn || typeof mn !== 'string') return '';
  const m = mn.toLowerCase();
  if (m.charCodeAt(0) === 46) return 'data';           // ".byte" from SKIPDATA
  if (FLOW.has(m)) return 'flow';
  if (ARM64_CONDITIONAL_BRANCH.test(m)) return 'flow';
  if (m.charCodeAt(0) === 106 /* j */ && /^j(?:mp|[a-z]{1,4})$/.test(m)) return 'flow';
  return '';
}
