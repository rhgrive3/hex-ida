/*
 * Track 10 (§9.3 / §10.2 / §15.1): Export / Import Interoperability Module.
 *
 * Generates and validates:
 *   1. Clean C11 header (`.h`) with strict C-type/signature whitelisting,
 *      topological struct/union/enum ordering, padding, bitfields,
 *      negative-offset notes, and `HEX_CONTAINER_OF`.
 *   2. Ghidra / IDA-compatible JSON symbol & type map (`hex-ida-interop/v1`)
 *      plus one-liner IDA Python import script, with deep validation & size cap.
 *   3. DWARF-like JSON summary (`hex-dwarf-summary/v1`).
 *   4. HEX-DB delta bundle v2 (`hex-delta-session`, versions 1 & 2) unified
 *      with `js/cache/delta-session.js` for mutual round-trip, strict schema
 *      validation, 512 KiB size cap, and lossless v1 migration.
 *   5. Frida hook snippet generator (§10.2) with injection-safe serialization.
 *
 * Pure ESM, zero external dependencies, strictly XSS-safe DOM modal renderer
 * with AbortController listener cleanup.
 */

import {
  encodeBinExport2,
  decodeBinExport2,
  CALL_GRAPH_VERTEX_TYPE,
  COMMENT_TYPE,
  MAX_BINEXPORT2_BYTES,
} from './binexport2-writer.js';

export const INTEROP_SCHEMA_ID = 'hex-ida-interop/v1';
export const DWARF_SUMMARY_SCHEMA_ID = 'hex-dwarf-summary/v1';
export const HEXDB_DELTA_FORMAT = 'hex-delta-session';
export const HEXDB_DELTA_VERSION = 2;
export const SUPPORTED_DELTA_VERSIONS = Object.freeze(new Set([1, 2]));
export const MAX_DELTA_BUNDLE_BYTES = 512 * 1024; // 512 KiB (§9.3 / §15.1)
export const MAX_INTEROP_JSON_BYTES = 8 * 1024 * 1024; // 8 MiB safety cap

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const VA_STR_RE = /^(?:0x[0-9a-f]+|\d+)$/i;
const CTRL_AND_LINE_SEP_RE = /[\u0000-\u001F\u007F\u2028\u2029]/;
const COMMENT_BREAK_RE = /[\r\n\u2028\u2029]+/g;
const STRICT_C_TYPE_RE = /^[A-Za-z_][A-Za-z0-9_\s*[\](),]*$/;
const STRICT_C_SIG_RE = /^[A-Za-z_][A-Za-z0-9_\s*[\](),.]*$/;

function sanitizeCIdent(name, fallback = 'unnamed') {
  const cleaned = String(name ?? '')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/^(\d)/, '_$1');
  return cleaned || fallback;
}

function sanitizeCComment(text) {
  return String(text ?? '')
    .replace(/\*\//g, '* /')
    .replace(COMMENT_BREAK_RE, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
}

function hasBalancedParensAndBrackets(str) {
  const stack = [];
  const pairs = { ')': '(', ']': '[' };
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === '(' || ch === '[') stack.push(ch);
    else if (ch === ')' || ch === ']') {
      if (stack.length === 0 || stack[stack.length - 1] !== pairs[ch]) return false;
      stack.pop();
    }
  }
  return stack.length === 0;
}

/**
 * Strict Fail-Closed C type whitelist for `.h` emission.
 * Rejects `;{}#\\`, `//`, `/*`, `*\/`, `<`, `>`, quotes, and control chars.
 */
export function sanitizeCTypeStrict(rawType, fallback = 'uintptr_t') {
  const s = String(rawType ?? '').trim();
  if (!s) return fallback;
  if (CTRL_AND_LINE_SEP_RE.test(s)) return fallback;
  if (/[;{}#\\<>'"`$]/.test(s)) return fallback;
  if (s.includes('//') || s.includes('/*') || s.includes('*/')) return fallback;
  if (!STRICT_C_TYPE_RE.test(s)) return fallback;
  if (!hasBalancedParensAndBrackets(s)) return fallback;
  return s.replace(/\s+/g, ' ');
}

/**
 * Strict Fail-Closed C function prototype validator for `.h` emission.
 */
export function sanitizeCFunctionSigStrict(rawSig, fnName, vaHex) {
  const safeFallback = `void ${sanitizeCIdent(fnName, `sub_${vaHex.slice(2)}`)}(void)`;
  const s = String(rawSig ?? '').trim().replace(/;$/, '').trim();
  if (!s) return safeFallback;
  if (CTRL_AND_LINE_SEP_RE.test(s)) return safeFallback;
  if (/[;{}#\\<>'"`$]/.test(s)) return safeFallback;
  if (s.includes('//') || s.includes('/*') || s.includes('*/')) return safeFallback;
  if (!STRICT_C_SIG_RE.test(s)) return safeFallback;
  if (!hasBalancedParensAndBrackets(s)) return safeFallback;
  const openIdx = s.indexOf('(');
  const closeIdx = s.lastIndexOf(')');
  if (openIdx <= 0 || closeIdx !== s.length - 1) return safeFallback;
  const head = s.slice(0, openIdx).trim();
  if (!/\s/.test(head)) return safeFallback;
  return s.replace(/\s+/g, ' ');
}

export function parseVaToBigInt(va) {
  if (typeof va === 'bigint') return va >= 0n ? va : null;
  if (typeof va === 'number') {
    if (!Number.isSafeInteger(va) || va < 0 || Object.is(va, -0)) return null;
    return BigInt(va);
  }
  const s = String(va ?? '').trim();
  if (!VA_STR_RE.test(s)) return null;
  try {
    const big = BigInt(s);
    return big >= 0n ? big : null;
  } catch {
    return null;
  }
}

function formatHexVa(va) {
  const big = parseVaToBigInt(va);
  return big == null ? '0x0' : `0x${big.toString(16)}`;
}

function hasForbiddenKeys(obj, seen = new Set()) {
  if (!obj || typeof obj !== 'object') return false;
  if (seen.has(obj)) return false;
  seen.add(obj);
  if (Array.isArray(obj)) {
    return obj.some((item) => hasForbiddenKeys(item, seen));
  }
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (FORBIDDEN_KEYS.has(key)) return true;
    if (hasForbiddenKeys(obj[key], seen)) return true;
  }
  return false;
}

function deepCloneSafe(val, depth = 0) {
  if (depth > 16 || val === null || val === undefined) return val ?? null;
  if (typeof val === 'bigint') return `0x${val.toString(16)}`;
  if (typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map((x) => deepCloneSafe(x, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    out[k] = deepCloneSafe(v, depth + 1);
  }
  return out;
}

function utf8ByteLength(str) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str).length;
  }
  return Buffer.byteLength(str, 'utf8');
}

function topoSortTypes(structs) {
  const list = Array.isArray(structs) ? structs : [];
  const byName = new Map();
  for (const s of list) {
    const n = sanitizeCIdent(s?.name, 'AnonStruct');
    byName.set(n, { ...s, _cleanName: n });
  }
  const visited = new Set();
  const visiting = new Set();
  const sorted = [];

  function visit(name) {
    if (visited.has(name) || visiting.has(name)) return;
    const item = byName.get(name);
    if (!item) return;
    visiting.add(name);
    const members = Array.isArray(item.members) ? item.members : [];
    for (const m of members) {
      const typeStr = String(m?.type ?? '');
      if (!typeStr.includes('*')) {
        for (const depName of byName.keys()) {
          if (depName !== name && new RegExp(`\\b${depName}\\b`).test(typeStr)) {
            visit(depName);
          }
        }
      }
    }
    visiting.delete(name);
    visited.add(name);
    sorted.push(item);
  }

  for (const name of byName.keys()) visit(name);
  return sorted;
}

/* ── 1. Clean C11 Header (.h) Export ─────────────────────────── */

export function exportCHeader(model = {}, options = {}) {
  const guard = sanitizeCIdent(options.headerGuard ?? 'HEX_IDA_TYPES_H').toUpperCase();
  const lines = [];
  lines.push(`/* Generated by hex-ida export-interop (${INTEROP_SCHEMA_ID}) */`);
  if (model.binarySha256) {
    lines.push(`/* Binary SHA-256: ${sanitizeCComment(model.binarySha256)} */`);
  }
  lines.push(`#ifndef ${guard}`);
  lines.push(`#define ${guard}`);
  lines.push('');
  if (!options.noStdHeaders) {
    lines.push('#include <stdint.h>');
    lines.push('#include <stdbool.h>');
    lines.push('#include <stddef.h>');
    lines.push('');
  }

  const shiftedPtrs = Array.isArray(model.shiftedPtrs) ? model.shiftedPtrs : [];
  if (shiftedPtrs.length > 0 || options.includeContainerOf) {
    lines.push('#ifndef HEX_CONTAINER_OF');
    lines.push('#define HEX_CONTAINER_OF(ptr, type, off) ((type *)((char *)(ptr) - (__PTRDIFF_TYPE__)(off)))');
    lines.push('#endif');
    lines.push('');
  }

  // Enums
  const enums = Array.isArray(model.enums) ? model.enums : [];
  for (const en of enums) {
    const eName = sanitizeCIdent(en?.name, 'AnonEnum');
    lines.push(`typedef enum ${eName} {`);
    const entries = Array.isArray(en?.values) ? en.values : [];
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const k = sanitizeCIdent(entry?.name, `VAL_${i}`);
      const v = Number.isSafeInteger(entry?.value) ? entry.value : i;
      const comma = i < entries.length - 1 ? ',' : '';
      lines.push(`  ${k} = ${v}${comma}`);
    }
    lines.push(`} ${eName};`);
    lines.push('');
  }

  // Forward declarations
  const sortedStructs = topoSortTypes(model.structs);
  if (sortedStructs.length > 0) {
    for (const st of sortedStructs) {
      const kw = st.kind === 'union' ? 'union' : 'struct';
      lines.push(`typedef ${kw} ${st._cleanName} ${st._cleanName};`);
    }
    lines.push('');
  }

  // Struct / Union definitions
  for (const st of sortedStructs) {
    const kw = st.kind === 'union' ? 'union' : 'struct';
    const members = Array.isArray(st.members)
      ? [...st.members].sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0))
      : [];
    const negMembers = members.filter((m) => Number(m.offset) < 0);
    const posMembers = members.filter((m) => Number(m.offset ?? 0) >= 0);

    if (negMembers.length > 0) {
      lines.push(`/* Note: ${st._cleanName} has negative-offset members (access via uintptr_t helper):`);
      for (const nm of negMembers) {
        lines.push(` *   offset ${Number(nm.offset)}: ${sanitizeCTypeStrict(nm.type, 'uint64_t')} ${sanitizeCIdent(nm.name)}`);
      }
      lines.push(' */');
    }

    lines.push(`${kw} ${st._cleanName} {`);
    let cursor = 0;
    let padIdx = 0;
    for (const m of posMembers) {
      const off = Number.isSafeInteger(m.offset) ? m.offset : cursor;
      const mSize = Number.isSafeInteger(m.size) && m.size > 0 ? m.size : 4;
      if (kw === 'struct' && off > cursor) {
        const gap = off - cursor;
        lines.push(`  uint8_t _pad_0x${cursor.toString(16)}[${gap}]; /* +0x${cursor.toString(16)} */`);
        padIdx += 1;
        cursor = off;
      }
      const mType = sanitizeCTypeStrict(m.type, 'uint32_t');
      const mName = sanitizeCIdent(m.name, `field_0x${off.toString(16)}`);
      if (Number.isSafeInteger(m.bfWidth) && m.bfWidth > 0 && m.bfWidth <= 64) {
        lines.push(`  ${mType} ${mName} : ${m.bfWidth}; /* +0x${off.toString(16)} bit ${Number.isSafeInteger(m.bfLsb) ? m.bfLsb : 0} */`);
      } else {
        lines.push(`  ${mType} ${mName}; /* +0x${off.toString(16)} */`);
      }
      if (kw === 'struct') {
        cursor = Math.max(cursor, off + mSize);
      }
    }
    if (kw === 'struct' && Number.isSafeInteger(st.size) && st.size > cursor) {
      lines.push(`  uint8_t _pad_0x${cursor.toString(16)}[${st.size - cursor}]; /* tail pad */`);
    }
    if (posMembers.length === 0 && padIdx === 0) {
      lines.push('  uint8_t _opaque[1];');
    }
    lines.push('};');
    lines.push('');
  }

  // Globals
  const globals = Array.isArray(model.globals) ? model.globals : [];
  if (globals.length > 0) {
    lines.push('/* Globals */');
    for (const g of globals) {
      const gType = sanitizeCTypeStrict(g?.type, 'uintptr_t');
      const gName = sanitizeCIdent(g?.name, `g_${formatHexVa(g?.va).slice(2)}`);
      lines.push(`extern ${gType} ${gName}; /* VA: ${formatHexVa(g?.va)} */`);
    }
    lines.push('');
  }

  // Function prototypes
  const functions = Array.isArray(model.functions) ? model.functions : [];
  if (functions.length > 0) {
    lines.push('/* Function Prototypes */');
    for (const fn of functions) {
      const va = formatHexVa(fn?.va);
      const comment = fn?.comment ? ` - ${sanitizeCComment(fn.comment)}` : '';
      const safeSig = sanitizeCFunctionSigStrict(fn?.sig, fn?.name, va);
      lines.push(`/* VA: ${va}${comment} */`);
      lines.push(`${safeSig};`);
    }
    lines.push('');
  }

  lines.push(`#endif /* ${guard} */`);
  return lines.join('\n') + '\n';
}

/* ── 2. Ghidra / IDA-Compatible JSON (hex-ida-interop/v1) ────── */

export function buildIdaPythonOneLiner() {
  return 'import json, idc; d = json.load(open("hex_ida_interop.json")); [idc.set_name(int(f["va"], 16), f["name"], idc.SN_NOWARN) for f in d.get("functions", [])]';
}

export function exportInteropJson(model = {}) {
  const functions = (Array.isArray(model.functions) ? model.functions : []).map((f) => ({
    va: formatHexVa(f?.va),
    name: String(f?.name ?? `sub_${formatHexVa(f?.va).slice(2)}`),
    sig: String(f?.sig ?? ''),
    comment: String(f?.comment ?? ''),
    pinned: Boolean(f?.pinned),
  }));

  const structs = (Array.isArray(model.structs) ? model.structs : []).map((s) => ({
    name: String(s?.name ?? 'AnonStruct'),
    kind: s?.kind === 'union' ? 'union' : 'struct',
    size: Number.isSafeInteger(s?.size) && s.size >= 0 ? s.size : 0,
    align: Number.isSafeInteger(s?.align) && s.align > 0 ? s.align : 8,
    members: (Array.isArray(s?.members) ? s.members : []).map((m) => ({
      offset: Number.isSafeInteger(m?.offset) ? m.offset : 0,
      name: String(m?.name ?? 'field'),
      type: String(m?.type ?? 'uint32_t'),
      size: Number.isSafeInteger(m?.size) && m.size > 0 ? m.size : 4,
      bfLsb: Number.isSafeInteger(m?.bfLsb) ? m.bfLsb : 0,
      bfWidth: Number.isSafeInteger(m?.bfWidth) ? m.bfWidth : 0,
    })),
  }));

  const enums = (Array.isArray(model.enums) ? model.enums : []).map((e) => ({
    name: String(e?.name ?? 'AnonEnum'),
    values: (Array.isArray(e?.values) ? e.values : []).map((v, idx) => ({
      name: String(v?.name ?? `VAL_${idx}`),
      value: Number.isSafeInteger(v?.value) ? v.value : idx,
    })),
  }));

  const globals = (Array.isArray(model.globals) ? model.globals : []).map((g) => ({
    va: formatHexVa(g?.va),
    name: String(g?.name ?? `g_${formatHexVa(g?.va).slice(2)}`),
    type: String(g?.type ?? 'uintptr_t'),
  }));

  return {
    schema: INTEROP_SCHEMA_ID,
    binarySha256: String(model.binarySha256 ?? ''),
    arch: String(model.arch ?? 'arm64'),
    imageBase: formatHexVa(model.imageBase ?? '0x100000000'),
    functions,
    structs,
    enums,
    globals,
    idaPythonOneLiner: buildIdaPythonOneLiner(),
  };
}

export function validateInteropJson(input, options = {}) {
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : MAX_INTEROP_JSON_BYTES;
  const errors = [];
  let data = input;
  if (typeof input === 'string') {
    const bytes = utf8ByteLength(input);
    if (bytes > maxBytes) {
      return { valid: false, errors: [`Interop JSON exceeds size cap (${bytes} > ${maxBytes} bytes)`], data: null };
    }
    try {
      data = JSON.parse(input);
    } catch (err) {
      return { valid: false, errors: [`Invalid JSON: ${err.message}`], data: null };
    }
  } else if (data && typeof data === 'object') {
    const bytes = utf8ByteLength(JSON.stringify(data));
    if (bytes > maxBytes) {
      return { valid: false, errors: [`Interop JSON exceeds size cap (${bytes} > ${maxBytes} bytes)`], data: null };
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['Interop payload must be a JSON object'], data: null };
  }
  if (hasForbiddenKeys(data)) {
    return { valid: false, errors: ['Forbidden prototype-pollution key detected'], data: null };
  }
  if (data.schema !== INTEROP_SCHEMA_ID) {
    errors.push(`Unsupported schema: expected "${INTEROP_SCHEMA_ID}", got "${String(data.schema)}"`);
  }
  if (!Array.isArray(data.functions)) errors.push('functions must be an array');
  if (!Array.isArray(data.structs)) errors.push('structs must be an array');
  if (!Array.isArray(data.globals)) errors.push('globals must be an array');
  if (data.enums != null && !Array.isArray(data.enums)) errors.push('enums must be an array when present');

  if (Array.isArray(data.functions)) {
    data.functions.forEach((f, i) => {
      if (!f || typeof f !== 'object' || Array.isArray(f)) {
        errors.push(`functions[${i}] must be an object`);
        return;
      }
      if (parseVaToBigInt(f.va) == null) errors.push(`functions[${i}].va is invalid`);
      if (typeof f.name !== 'string' || !f.name.trim()) errors.push(`functions[${i}].name must be non-empty string`);
    });
  }
  if (Array.isArray(data.structs)) {
    data.structs.forEach((s, i) => {
      if (!s || typeof s !== 'object' || Array.isArray(s)) {
        errors.push(`structs[${i}] must be an object`);
        return;
      }
      if (typeof s.name !== 'string' || !s.name.trim()) errors.push(`structs[${i}].name must be non-empty string`);
      if (!Array.isArray(s.members)) {
        errors.push(`structs[${i}].members must be an array`);
      } else {
        s.members.forEach((m, j) => {
          if (!m || typeof m !== 'object' || Array.isArray(m)) {
            errors.push(`structs[${i}].members[${j}] must be an object`);
            return;
          }
          if (!Number.isSafeInteger(m.offset)) errors.push(`structs[${i}].members[${j}].offset must be an integer`);
          if (typeof m.name !== 'string' || !m.name.trim()) errors.push(`structs[${i}].members[${j}].name must be non-empty string`);
          if (typeof m.type !== 'string' || !m.type.trim()) errors.push(`structs[${i}].members[${j}].type must be non-empty string`);
          if (m.size != null && (!Number.isSafeInteger(m.size) || m.size < 1)) {
            errors.push(`structs[${i}].members[${j}].size must be >= 1`);
          }
          if (m.bfWidth != null && (!Number.isSafeInteger(m.bfWidth) || m.bfWidth < 0 || m.bfWidth > 64)) {
            errors.push(`structs[${i}].members[${j}].bfWidth must be 0..64`);
          }
        });
      }
    });
  }
  if (Array.isArray(data.enums)) {
    data.enums.forEach((en, i) => {
      if (!en || typeof en !== 'object' || Array.isArray(en)) {
        errors.push(`enums[${i}] must be an object`);
        return;
      }
      if (typeof en.name !== 'string' || !en.name.trim()) errors.push(`enums[${i}].name must be non-empty string`);
      if (!Array.isArray(en.values)) {
        errors.push(`enums[${i}].values must be an array`);
      } else {
        en.values.forEach((v, j) => {
          if (!v || typeof v !== 'object' || Array.isArray(v)) {
            errors.push(`enums[${i}].values[${j}] must be an object`);
            return;
          }
          if (typeof v.name !== 'string' || !v.name.trim()) errors.push(`enums[${i}].values[${j}].name must be non-empty string`);
          if (!Number.isSafeInteger(v.value)) errors.push(`enums[${i}].values[${j}].value must be an integer`);
        });
      }
    });
  }
  if (Array.isArray(data.globals)) {
    data.globals.forEach((g, i) => {
      if (!g || typeof g !== 'object' || Array.isArray(g)) {
        errors.push(`globals[${i}] must be an object`);
        return;
      }
      if (parseVaToBigInt(g.va) == null) errors.push(`globals[${i}].va is invalid`);
    });
  }

  return { valid: errors.length === 0, errors, data: errors.length === 0 ? data : null };
}

export function importInteropJson(input, options = {}) {
  const res = validateInteropJson(input, options);
  if (!res.valid) return { ok: false, errors: res.errors, model: null };
  const d = res.data;
  return {
    ok: true,
    errors: [],
    model: {
      binarySha256: String(d.binarySha256 ?? ''),
      arch: String(d.arch ?? 'arm64'),
      imageBase: formatHexVa(d.imageBase ?? '0x0'),
      functions: d.functions.map((f) => ({
        va: formatHexVa(f.va),
        name: String(f.name),
        sig: String(f.sig ?? ''),
        comment: String(f.comment ?? ''),
        pinned: Boolean(f.pinned),
      })),
      structs: d.structs.map((s) => ({
        name: String(s.name),
        kind: s.kind === 'union' ? 'union' : 'struct',
        size: Number.isSafeInteger(s.size) ? s.size : 0,
        align: Number.isSafeInteger(s.align) && s.align > 0 ? s.align : 8,
        members: s.members.map((m) => ({
          offset: Number(m.offset),
          name: String(m.name),
          type: String(m.type),
          size: Number.isSafeInteger(m.size) && m.size > 0 ? m.size : 4,
          bfLsb: Number.isSafeInteger(m.bfLsb) ? m.bfLsb : 0,
          bfWidth: Number.isSafeInteger(m.bfWidth) ? m.bfWidth : 0,
        })),
      })),
      enums: Array.isArray(d.enums)
        ? d.enums.map((e) => ({
          name: String(e.name),
          values: e.values.map((v) => ({ name: String(v.name), value: Number(v.value) })),
        }))
        : [],
      globals: d.globals.map((g) => ({
        va: formatHexVa(g.va),
        name: String(g.name ?? ''),
        type: String(g.type ?? 'uintptr_t'),
      })),
    },
  };
}

/* ── 3. DWARF-Like JSON Summary (hex-dwarf-summary/v1) ───────── */

export function exportDwarfSummaryJson(model = {}) {
  const functions = Array.isArray(model.functions) ? model.functions : [];
  const structs = Array.isArray(model.structs) ? model.structs : [];
  const enums = Array.isArray(model.enums) ? model.enums : [];
  const globals = Array.isArray(model.globals) ? model.globals : [];

  const subprograms = functions.map((fn) => {
    const lowBig = parseVaToBigInt(fn?.va) ?? 0n;
    const lowPc = `0x${lowBig.toString(16)}`;
    const size = Number.isSafeInteger(fn?.size) && fn.size > 0 ? BigInt(fn.size) : 0n;
    const highPc = `0x${(lowBig + size).toString(16)}`;
    return {
      tag: 'DW_TAG_subprogram',
      name: String(fn?.name ?? `sub_${lowBig.toString(16)}`),
      lowPc,
      highPc,
      returnType: String(fn?.returnType ?? 'void'),
      signature: String(fn?.sig ?? ''),
      params: Array.isArray(fn?.params) ? fn.params.map((p) => ({
        tag: 'DW_TAG_formal_parameter',
        name: String(p?.name ?? 'arg'),
        type: String(p?.type ?? 'uint64_t'),
      })) : [],
      locals: Array.isArray(fn?.locals) ? fn.locals.map((l) => ({
        tag: 'DW_TAG_variable',
        name: String(l?.name ?? 'local'),
        type: String(l?.type ?? 'uint64_t'),
      })) : [],
      chunks: Array.isArray(fn?.chunks) ? fn.chunks.map((c) => ({
        lowPc: formatHexVa(c.startVa),
        highPc: formatHexVa(c.endVa),
      })) : [],
    };
  });

  const types = [
    ...structs.map((s) => ({
      tag: s?.kind === 'union' ? 'DW_TAG_union_type' : 'DW_TAG_structure_type',
      name: String(s?.name ?? 'AnonStruct'),
      byteSize: Number.isSafeInteger(s?.size) ? s.size : 0,
      members: (Array.isArray(s?.members) ? s.members : []).map((m) => ({
        tag: 'DW_TAG_member',
        name: String(m?.name ?? 'field'),
        type: String(m?.type ?? 'uint32_t'),
        dataMemberLocation: Number.isSafeInteger(m?.offset) ? m.offset : 0,
        byteSize: Number.isSafeInteger(m?.size) ? m.size : 4,
        bitSize: Number.isSafeInteger(m?.bfWidth) && m.bfWidth > 0 ? m.bfWidth : undefined,
        bitOffset: Number.isSafeInteger(m?.bfWidth) && m.bfWidth > 0 ? (m.bfLsb ?? 0) : undefined,
      })),
    })),
    ...enums.map((e) => ({
      tag: 'DW_TAG_enumeration_type',
      name: String(e?.name ?? 'AnonEnum'),
      enumerators: (Array.isArray(e?.values) ? e.values : []).map((v, i) => ({
        tag: 'DW_TAG_enumerator',
        name: String(v?.name ?? `VAL_${i}`),
        constValue: Number.isSafeInteger(v?.value) ? v.value : i,
      })),
    })),
  ];

  const variables = globals.map((g) => ({
    tag: 'DW_TAG_variable',
    name: String(g?.name ?? `g_${formatHexVa(g?.va).slice(2)}`),
    locationVa: formatHexVa(g?.va),
    type: String(g?.type ?? 'uintptr_t'),
  }));

  return {
    schema: DWARF_SUMMARY_SCHEMA_ID,
    binarySha256: String(model.binarySha256 ?? ''),
    arch: String(model.arch ?? 'arm64'),
    compileUnits: [
      {
        tag: 'DW_TAG_compile_unit',
        name: String(model.binaryName ?? 'recovered_unit.c'),
        lowPc: formatHexVa(model.imageBase ?? '0x0'),
        subprograms,
        types,
        variables,
      },
    ],
  };
}

export function validateDwarfSummaryJson(input) {
  const errors = [];
  let data = input;
  if (typeof input === 'string') {
    if (utf8ByteLength(input) > MAX_INTEROP_JSON_BYTES) {
      return { valid: false, errors: ['DWARF summary exceeds size cap'], data: null };
    }
    try {
      data = JSON.parse(input);
    } catch (err) {
      return { valid: false, errors: [`Invalid JSON: ${err.message}`], data: null };
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['DWARF summary must be a JSON object'], data: null };
  }
  if (hasForbiddenKeys(data)) {
    return { valid: false, errors: ['Forbidden prototype-pollution key detected'], data: null };
  }
  if (data.schema !== DWARF_SUMMARY_SCHEMA_ID) {
    errors.push(`Unsupported schema: expected "${DWARF_SUMMARY_SCHEMA_ID}"`);
  }
  if (!Array.isArray(data.compileUnits) || data.compileUnits.length === 0) {
    errors.push('compileUnits must be a non-empty array');
  } else {
    data.compileUnits.forEach((cu, idx) => {
      if (cu?.tag !== 'DW_TAG_compile_unit') errors.push(`compileUnits[${idx}].tag must be DW_TAG_compile_unit`);
      if (!Array.isArray(cu?.subprograms)) errors.push(`compileUnits[${idx}].subprograms must be an array`);
      if (!Array.isArray(cu?.types)) errors.push(`compileUnits[${idx}].types must be an array`);
      if (!Array.isArray(cu?.variables)) errors.push(`compileUnits[${idx}].variables must be an array`);
    });
  }
  return { valid: errors.length === 0, errors, data: errors.length === 0 ? data : null };
}

/* ── 4. HEX-DB Delta Bundle v2 Export / Import (§9.3 / §15.1) ── */

function extractDeltaBody(raw) {
  if (raw?.delta && typeof raw.delta === 'object' && !Array.isArray(raw.delta)) {
    return raw.delta;
  }
  return raw ?? {};
}

function normalizeCollectionEntries(val) {
  if (Array.isArray(val)) return val;
  if (val && typeof val === 'object') return Object.values(val);
  return [];
}

/**
 * Exports a canonical `hex-delta-session` v2 bundle compatible with
 * `js/cache/delta-session.js` `parseDeltaJson()` for lossless mutual round-trip.
 */
export function exportHexDbDeltaBundle(state = {}, options = {}) {
  const srcDelta = extractDeltaBody(state);
  const sha256 = String(state.fingerprint?.sha256 ?? state.binarySha256 ?? '');
  const binaryName = String(state.fingerprint?.name ?? state.binaryName ?? '');
  const updatedAt = Number.isFinite(Number(options.updatedAt ?? state.updatedAt))
    ? Number(options.updatedAt ?? state.updatedAt)
    : Date.now();

  const delta = {
    names: deepCloneSafe(srcDelta.names ?? srcDelta.renames ?? {}),
    comments: deepCloneSafe(srcDelta.comments ?? {}),
    vars: deepCloneSafe(srcDelta.vars ?? {}),
    types: deepCloneSafe(srcDelta.types ?? {}),
    structs: Array.isArray(srcDelta.structs) ? deepCloneSafe(srcDelta.structs) : [],
    bookmarks: Array.isArray(srcDelta.bookmarks) ? deepCloneSafe(srcDelta.bookmarks) : [],
    patches: Array.isArray(srcDelta.patches) ? deepCloneSafe(srcDelta.patches) : [],
    projectAnnotations: Array.isArray(srcDelta.projectAnnotations) ? deepCloneSafe(srcDelta.projectAnnotations) : [],
    displayHints: deepCloneSafe(srcDelta.displayHints ?? {}),
    manualSegments: Array.isArray(srcDelta.manualSegments) ? deepCloneSafe(srcDelta.manualSegments) : [],
    funcChunks: Array.isArray(srcDelta.funcChunks) ? deepCloneSafe(srcDelta.funcChunks) : [],
    customAbis: Array.isArray(srcDelta.customAbis)
      ? deepCloneSafe(srcDelta.customAbis)
      : deepCloneSafe(srcDelta.customAbis ?? []),
    stackSlotOverrides: Array.isArray(srcDelta.stackSlotOverrides)
      ? deepCloneSafe(srcDelta.stackSlotOverrides)
      : deepCloneSafe(srcDelta.stackSlotOverrides ?? []),
    shiftedPtrs: Array.isArray(srcDelta.shiftedPtrs)
      ? deepCloneSafe(srcDelta.shiftedPtrs)
      : deepCloneSafe(srcDelta.shiftedPtrs ?? []),
    pinnedMasks: deepCloneSafe(srcDelta.pinnedMasks ?? {}),
  };

  const bundle = {
    format: HEXDB_DELTA_FORMAT,
    version: HEXDB_DELTA_VERSION,
    fingerprint: {
      sha256: sha256 || null,
      name: binaryName || null,
      architecture: state.fingerprint?.architecture ?? state.arch ?? null,
    },
    updatedAt,
    delta,
    resume: state.resume && typeof state.resume === 'object' ? deepCloneSafe(state.resume) : {},
  };

  const json = JSON.stringify(bundle, null, 2);
  const bytes = utf8ByteLength(json);
  if (bytes > MAX_DELTA_BUNDLE_BYTES) {
    throw new Error(`HEX-DB delta bundle exceeds 512 KiB budget (${bytes} bytes > ${MAX_DELTA_BUNDLE_BYTES})`);
  }
  return { bundle, json, byteLength: bytes };
}

export function validateHexDbDeltaBundle(input) {
  const errors = [];
  let data = input;
  if (typeof input === 'string') {
    const bytes = utf8ByteLength(input);
    if (bytes > MAX_DELTA_BUNDLE_BYTES) {
      return { valid: false, errors: [`Delta bundle exceeds 512 KiB limit (${bytes} bytes)`], data: null };
    }
    try {
      data = JSON.parse(input);
    } catch (err) {
      return { valid: false, errors: [`Invalid JSON: ${err.message}`], data: null };
    }
  } else if (data && typeof data === 'object') {
    const bytes = utf8ByteLength(JSON.stringify(data));
    if (bytes > MAX_DELTA_BUNDLE_BYTES) {
      return { valid: false, errors: [`Delta bundle exceeds 512 KiB limit (${bytes} bytes)`], data: null };
    }
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['Delta bundle must be a JSON object'], data: null };
  }
  if (hasForbiddenKeys(data)) {
    return { valid: false, errors: ['Forbidden prototype-pollution key detected'], data: null };
  }
  if (data.format !== HEXDB_DELTA_FORMAT) {
    errors.push(`Invalid format: expected "${HEXDB_DELTA_FORMAT}", got "${String(data.format)}"`);
  }
  if (!SUPPORTED_DELTA_VERSIONS.has(data.version)) {
    errors.push(`Unsupported delta version: ${String(data.version)} (supported: 1, 2)`);
  }

  const body = extractDeltaBody(data);

  if (body.manualSegments != null) {
    if (!Array.isArray(body.manualSegments)) {
      errors.push('manualSegments must be an array');
    } else {
      body.manualSegments.forEach((seg, i) => {
        if (!seg || typeof seg !== 'object' || Array.isArray(seg)) {
          errors.push(`manualSegments[${i}] must be an object`);
          return;
        }
        if (parseVaToBigInt(seg.startVa) == null) errors.push(`manualSegments[${i}].startVa is invalid`);
        if (!Number.isSafeInteger(seg.byteLen) || seg.byteLen < 1) errors.push(`manualSegments[${i}].byteLen must be >= 1`);
        if (!Number.isSafeInteger(seg.kind) || seg.kind < 0 || seg.kind > 7) errors.push(`manualSegments[${i}].kind must be 0..7`);
      });
    }
  }

  if (body.funcChunks != null) {
    if (!Array.isArray(body.funcChunks)) {
      errors.push('funcChunks must be an array');
    } else {
      body.funcChunks.forEach((ch, i) => {
        const s = parseVaToBigInt(ch?.startVa);
        const e = parseVaToBigInt(ch?.endVa);
        if (s == null || e == null || e <= s) {
          errors.push(`funcChunks[${i}] requires valid startVa < endVa`);
        }
      });
    }
  }

  if (body.customAbis != null) {
    if (typeof body.customAbis !== 'object') {
      errors.push('customAbis must be an array or object');
    } else {
      normalizeCollectionEntries(body.customAbis).forEach((abi, i) => {
        if (!abi || typeof abi !== 'object') {
          errors.push(`customAbis[${i}] must be an object`);
          return;
        }
        if (parseVaToBigInt(abi.funcVa) == null) errors.push(`customAbis[${i}].funcVa is invalid`);
        const argCount = Array.isArray(abi.args) ? abi.args.length : Number(abi.argCount ?? 0);
        if (!Number.isSafeInteger(argCount) || argCount < 0 || argCount > 12) {
          errors.push(`customAbis[${i}] exceeds 12 arguments`);
        }
        const purge = Number(abi.spPurgeBytes ?? 0);
        if (!Number.isSafeInteger(purge) || purge < 0 || purge % 16 !== 0) {
          errors.push(`customAbis[${i}].spPurgeBytes must be 16-byte aligned`);
        }
      });
    }
  }

  if (body.stackSlotOverrides != null) {
    if (typeof body.stackSlotOverrides !== 'object') {
      errors.push('stackSlotOverrides must be an array or object');
    } else {
      normalizeCollectionEntries(body.stackSlotOverrides).forEach((slot, i) => {
        if (!Number.isSafeInteger(slot?.spOffset)) errors.push(`stackSlotOverrides[${i}].spOffset must be an integer`);
        if (!Number.isSafeInteger(slot?.byteSize) || slot.byteSize < 1) errors.push(`stackSlotOverrides[${i}].byteSize must be >= 1`);
      });
    }
  }

  if (body.shiftedPtrs != null) {
    if (typeof body.shiftedPtrs !== 'object') {
      errors.push('shiftedPtrs must be an array or object');
    } else {
      normalizeCollectionEntries(body.shiftedPtrs).forEach((sp, i) => {
        if (typeof sp?.varKey !== 'string' || !sp.varKey.trim()) errors.push(`shiftedPtrs[${i}].varKey is required`);
        if (!Number.isSafeInteger(sp?.shiftOffset)) errors.push(`shiftedPtrs[${i}].shiftOffset must be an integer`);
      });
    }
  }

  return { valid: errors.length === 0, errors, data: errors.length === 0 ? data : null };
}

export function importHexDbDeltaBundle(input) {
  const res = validateHexDbDeltaBundle(input);
  if (!res.valid) return { ok: false, errors: res.errors, state: null, migratedFromV1: false };

  const d = res.data;
  const body = extractDeltaBody(d);
  const migratedFromV1 = d.version === 1;
  const manualSegments = Array.isArray(body.manualSegments) ? deepCloneSafe(body.manualSegments) : [];

  // Lossless v1 migration: legacy structOverrides (array or object) -> manualSegments
  const legacyOverrides = body.structOverrides ?? d.structOverrides;
  if (migratedFromV1 && Array.isArray(legacyOverrides)) {
    for (const legacy of legacyOverrides) {
      const startBig = parseVaToBigInt(legacy?.startVa ?? legacy?.va);
      if (startBig != null) {
        const sizeVal = legacy.byteLen ?? legacy.size;
        manualSegments.push({
          startVa: `0x${startBig.toString(16)}`,
          byteLen: Number.isSafeInteger(sizeVal) && sizeVal > 0 ? sizeVal : 8,
          kind: 5,
          migratedFromLegacyStructOverride: true,
          structName: legacy.structName ? String(legacy.structName) : undefined,
        });
      }
    }
  } else if (migratedFromV1 && legacyOverrides && typeof legacyOverrides === 'object') {
    for (const [k, v] of Object.entries(legacyOverrides)) {
      const startBig = parseVaToBigInt(k);
      if (startBig != null) {
        const sizeVal = v && typeof v === 'object' ? (v.byteLen ?? v.size) : 8;
        manualSegments.push({
          startVa: `0x${startBig.toString(16)}`,
          byteLen: Number.isSafeInteger(sizeVal) && sizeVal > 0 ? sizeVal : 8,
          kind: 5,
          migratedFromLegacyStructOverride: true,
          structName: typeof v === 'string' ? v : (v?.structName ? String(v.structName) : undefined),
        });
      }
    }
  }

  const sha256 = String(d.fingerprint?.sha256 ?? d.binarySha256 ?? '');
  const binaryName = String(d.fingerprint?.name ?? d.binaryName ?? '');
  const namesObj = deepCloneSafe(body.names ?? body.renames ?? {});

  return {
    ok: true,
    errors: [],
    migratedFromV1,
    state: {
      format: HEXDB_DELTA_FORMAT,
      version: HEXDB_DELTA_VERSION,
      binarySha256: sha256,
      binaryName,
      fingerprint: { sha256: sha256 || null, name: binaryName || null },
      renames: namesObj,
      names: namesObj,
      comments: deepCloneSafe(body.comments ?? {}),
      vars: deepCloneSafe(body.vars ?? {}),
      types: deepCloneSafe(body.types ?? {}),
      structs: Array.isArray(body.structs) ? deepCloneSafe(body.structs) : [],
      bookmarks: Array.isArray(body.bookmarks) ? deepCloneSafe(body.bookmarks) : [],
      patches: Array.isArray(body.patches) ? deepCloneSafe(body.patches) : [],
      displayHints: deepCloneSafe(body.displayHints ?? {}),
      manualSegments,
      funcChunks: Array.isArray(body.funcChunks) ? deepCloneSafe(body.funcChunks) : [],
      customAbis: normalizeCollectionEntries(body.customAbis).map((x) => deepCloneSafe(x)),
      stackSlotOverrides: normalizeCollectionEntries(body.stackSlotOverrides).map((x) => deepCloneSafe(x)),
      shiftedPtrs: normalizeCollectionEntries(body.shiftedPtrs).map((x) => deepCloneSafe(x)),
      pinnedMasks: deepCloneSafe(body.pinnedMasks ?? {}),
    },
  };
}

/* ── 5. Frida Hook Snippet Generator (§10.2) ─────────────────── */

function sanitizeSingleLineComment(text) {
  return String(text ?? '').replace(COMMENT_BREAK_RE, ' ').replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

function safeJsStringLiteral(text) {
  return JSON.stringify(String(text ?? ''))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function exportFridaSnippet(fn = {}, model = {}) {
  const moduleName = safeJsStringLiteral(model.binaryName || 'target_binary');
  const baseBig = parseVaToBigInt(model.imageBase ?? '0x0') ?? 0n;
  const fnBig = parseVaToBigInt(fn.va ?? '0x0') ?? 0n;
  const rva = fnBig >= baseBig ? fnBig - baseBig : 0n;
  const fnRawName = String(fn.name || `sub_${fnBig.toString(16)}`);
  const fnComment = sanitizeSingleLineComment(fnRawName);
  const fnJsonLit = safeJsStringLiteral(fnRawName);
  const archComment = sanitizeSingleLineComment(model.arch || 'arm64');
  const params = Array.isArray(fn.params) ? fn.params : [];

  const argLines = params.length > 0
    ? params.map((p, idx) => {
      const t = String(p?.type ?? '');
      const paramLabel = safeJsStringLiteral(`  arg${idx} (${String(p?.name || `a${idx}`)}):`);
      if (/\bchar\s*\*/.test(t)) {
        return `    console.log(${paramLabel}, args[${idx}].readUtf8String());`;
      }
      return `    console.log(${paramLabel}, args[${idx}]);`;
    })
    : ['    console.log("  arg0:", args[0], "arg1:", args[1]);'];

  return [
    `// Frida hook for ${fnComment} (arch: ${archComment})`,
    `const base = Module.findBaseAddress(${moduleName});`,
    'if (!base) throw new Error("Module not loaded");',
    `Interceptor.attach(base.add(0x${rva.toString(16)}), {`,
    '  onEnter(args) {',
    `    console.log("[enter]", ${fnJsonLit});`,
    ...argLines,
    '  },',
    '  onLeave(retval) {',
    `    console.log("[leave]", ${fnJsonLit}, "->", retval);`,
    '  },',
    '});',
    '',
  ].join('\n');
}

/* ── 5b. Google BinExport v2 (.BinExport) Protobuf Interop ───── */

function bytesToBase64(bytes) {
  if (typeof Buffer === 'function') {
    return Buffer.from(bytes).toString('base64');
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(raw) {
  const b64 = String(raw ?? '').replace(/\s+/g, '');
  if (b64.length === 0) {
    throw new TypeError('Empty base64 payload');
  }
  const maxB64Len = Math.ceil((MAX_BINEXPORT2_BYTES * 4) / 3) + 4;
  if (b64.length > maxB64Len) {
    throw new RangeError(`Base64 payload exceeds maximum allowed size (${b64.length} > ${maxB64Len})`);
  }
  if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new TypeError('Malformed base64 payload');
  }
  if (typeof Buffer === 'function') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function buildBinExport2FromModel(model = {}) {
  // If caller already supplied a native BinExport2 structure, pass through directly.
  if (model.metaInformation || model.meta_information || model.callGraph || model.call_graph) {
    return model;
  }
  const functions = Array.isArray(model.functions) ? model.functions : [];
  const vertices = functions.map((fn) => ({
    address: parseVaToBigInt(fn?.va) ?? 0n,
    type: fn?.isImported ? CALL_GRAPH_VERTEX_TYPE.IMPORTED : CALL_GRAPH_VERTEX_TYPE.NORMAL,
    mangledName: String(fn?.mangledName ?? fn?.name ?? ''),
    demangledName: fn?.demangledName ? String(fn.demangledName) : undefined,
  }));
  const edges = Array.isArray(model.callEdges) ? model.callEdges : [];
  const sections = (Array.isArray(model.sections) ? model.sections : []).map((s) => ({
    address: parseVaToBigInt(s?.address ?? s?.va) ?? 0n,
    size: parseVaToBigInt(s?.size) ?? 0n,
    flagR: Boolean(s?.flagR ?? s?.flag_r ?? true),
    flagW: Boolean(s?.flagW ?? s?.flag_w ?? false),
    flagX: Boolean(s?.flagX ?? s?.flag_x ?? false),
  }));
  const libraries = (Array.isArray(model.libraries) ? model.libraries : []).map((l) => ({
    isStatic: Boolean(l?.isStatic ?? l?.is_static),
    loadAddress: parseVaToBigInt(l?.loadAddress ?? l?.load_address ?? 0n) ?? 0n,
    name: String(l?.name ?? ''),
  }));
  const stringTable = [];
  const comments = [];
  const instructions = [];
  const basicBlocks = [];
  const flowGraphs = [];
  functions.forEach((fn, idx) => {
    const fnVa = parseVaToBigInt(fn?.va) ?? 0n;
    const insnIdx = instructions.length;
    const bbIdx = basicBlocks.length;
    const commentIndices = [];
    if (fn?.comment) {
      const strIdx = stringTable.length;
      const commentIdx = comments.length;
      stringTable.push(String(fn.comment));
      comments.push({ instructionIndex: insnIdx, stringTableIndex: strIdx, type: COMMENT_TYPE.FUNCTION });
      commentIndices.push(commentIdx);
    }
    instructions.push({ address: fnVa, commentIndex: commentIndices });
    basicBlocks.push({ instructionIndex: [{ beginIndex: insnIdx, endIndex: insnIdx + 1 }] });
    flowGraphs.push({ entryBasicBlockIndex: bbIdx, basicBlockIndex: [bbIdx], edge: [] });
  });

  return {
    metaInformation: {
      executableName: String(model.binaryName ?? 'unnamed.bin'),
      executableId: String(model.binarySha256 ?? ''),
      architectureName: String(model.arch ?? 'arm64'),
      timestamp: Number.isSafeInteger(model.timestamp) ? model.timestamp : 0,
    },
    instruction: instructions,
    basicBlock: basicBlocks,
    flowGraph: flowGraphs,
    callGraph: { vertex: vertices, edge: edges },
    section: sections,
    library: libraries,
    stringTable,
    comment: comments,
  };
}

export function exportBinExport2(model = {}) {
  const protoModel = buildBinExport2FromModel(model);
  const bytes = encodeBinExport2(protoModel);
  return {
    bytes,
    byteLength: bytes.byteLength,
    base64: bytesToBase64(bytes),
  };
}

export function importBinExport2(input) {
  try {
    let bytes;
    if (input instanceof Uint8Array) bytes = input;
    else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
    else if (typeof input === 'string') bytes = base64ToBytes(input);
    else return { ok: false, errors: ['Expected Uint8Array, ArrayBuffer, or base64 string'], data: null, model: null };

    if (bytes.byteLength === 0) {
      return { ok: false, errors: ['Empty BinExport2 payload'], data: null, model: null };
    }

    const data = decodeBinExport2(bytes);
    const model = {
      binaryName: data.metaInformation?.executableName ?? '',
      binarySha256: data.metaInformation?.executableId ?? '',
      arch: data.metaInformation?.architectureName ?? 'arm64',
      functions: (data.callGraph?.vertex ?? []).map((v) => ({
        va: `0x${(v.address ?? 0n).toString(16)}`,
        name: v.demangledName || v.mangledName || `sub_${(v.address ?? 0n).toString(16)}`,
        mangledName: v.mangledName ?? '',
        demangledName: v.demangledName ?? '',
        type: v.type,
      })),
      sections: data.section.map((s) => ({
        address: `0x${(s.address ?? 0n).toString(16)}`,
        size: Number(s.size ?? 0n),
        flagR: s.flagR,
        flagW: s.flagW,
        flagX: s.flagX,
      })),
      libraries: data.library,
    };
    return { ok: true, errors: [], data, model };
  } catch (err) {
    return { ok: false, errors: [err?.message || String(err)], data: null, model: null };
  }
}

/* ── 6. Contextual Export/Import Modal Controller & Safe View ── */

export const EXPORT_FORMATS = Object.freeze([
  'c-header',
  'interop-json',
  'dwarf-json',
  'hexdb-delta-v2',
  'binexport2',
]);

export function createExportInteropController(options = {}) {
  const onImportApplied = typeof options.onImportApplied === 'function' ? options.onImportApplied : null;
  let state = {
    open: false,
    format: 'c-header',
    model: options.model ?? {},
    deltaState: options.deltaState ?? {},
    previewText: '',
    importText: '',
    importStatus: null,
  };
  const listeners = new Set();

  function generatePreview(fmt, model, deltaState) {
    if (fmt === 'c-header') return exportCHeader(model);
    if (fmt === 'interop-json') return JSON.stringify(exportInteropJson(model), null, 2);
    if (fmt === 'dwarf-json') return JSON.stringify(exportDwarfSummaryJson(model), null, 2);
    if (fmt === 'hexdb-delta-v2') return exportHexDbDeltaBundle(deltaState).json;
    if (fmt === 'binexport2') return exportBinExport2(model).base64;
    return '';
  }

  function emit() {
    const snap = getState();
    for (const fn of listeners) fn(snap);
  }

  function getState() {
    return Object.freeze({
      open: state.open,
      format: state.format,
      previewText: state.previewText,
      importText: state.importText,
      importStatus: state.importStatus ? Object.freeze({ ...state.importStatus }) : null,
    });
  }

  function open({ format = 'c-header', model, deltaState } = {}) {
    const nextFormat = EXPORT_FORMATS.includes(format) ? format : 'c-header';
    const nextModel = model ?? state.model;
    const nextDelta = deltaState ?? state.deltaState;
    state = {
      ...state,
      open: true,
      format: nextFormat,
      model: nextModel,
      deltaState: nextDelta,
      previewText: generatePreview(nextFormat, nextModel, nextDelta),
      importStatus: null,
    };
    emit();
    return getState();
  }

  function close() {
    state = { ...state, open: false };
    emit();
    return getState();
  }

  function setFormat(format) {
    if (!EXPORT_FORMATS.includes(format)) return getState();
    state = {
      ...state,
      format,
      previewText: generatePreview(format, state.model, state.deltaState),
    };
    emit();
    return getState();
  }

  function setImportText(text) {
    state = { ...state, importText: String(text ?? '') };
    emit();
  }

  function applyImport(textOverride) {
    const raw = textOverride != null ? String(textOverride) : state.importText;
    let res;
    if (state.format === 'hexdb-delta-v2') {
      res = importHexDbDeltaBundle(raw);
    } else if (state.format === 'interop-json') {
      res = importInteropJson(raw);
    } else if (state.format === 'binexport2') {
      res = importBinExport2(raw);
    } else if (state.format === 'dwarf-json') {
      const v = validateDwarfSummaryJson(raw);
      res = { ok: v.valid, errors: v.errors, data: v.data };
    } else {
      res = { ok: false, errors: ['C header export is read-only; switch to JSON format to import'] };
    }
    state = {
      ...state,
      importText: raw,
      importStatus: { ok: Boolean(res.ok), errors: res.errors ?? [] },
    };
    if (res.ok && onImportApplied) onImportApplied(state.format, res);
    emit();
    return res;
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { open, close, setFormat, setImportText, applyImport, getState, subscribe };
}

export function renderExportInteropModal(controller, options = {}) {
  const doc = options.document ?? globalThis.document;
  if (!doc || typeof doc.createElement !== 'function') {
    throw new Error('renderExportInteropModal requires a document with createElement');
  }

  const ac = new AbortController();
  const { signal } = ac;

  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  };

  const root = el('div', 'hex-modal hex-export-interop-modal');
  root.setAttribute('role', 'dialog');
  root.setAttribute('data-modal', 'export-interop');

  const header = el('div', 'hex-modal-header');
  header.appendChild(el('h3', 'hex-modal-title', 'Export / Import Interop'));
  const closeBtn = el('button', 'hex-modal-close', '×');
  closeBtn.type = 'button';
  closeBtn.addEventListener('click', () => controller.close(), { signal });
  header.appendChild(closeBtn);

  const tabs = el('div', 'hex-export-tabs');
  const tabButtons = new Map();
  const labels = {
    'c-header': 'C Header (.h)',
    'interop-json': 'IDA/Ghidra JSON',
    'dwarf-json': 'DWARF Summary JSON',
    'hexdb-delta-v2': 'HEX-DB Delta v2',
    binexport2: 'BinExport v2 (.BinExport)',
  };
  for (const fmt of EXPORT_FORMATS) {
    const btn = el('button', 'hex-export-tab', labels[fmt]);
    btn.type = 'button';
    btn.setAttribute('data-format', fmt);
    btn.addEventListener('click', () => controller.setFormat(fmt), { signal });
    tabs.appendChild(btn);
    tabButtons.set(fmt, btn);
  }

  const previewPre = el('pre', 'hex-export-preview', '');
  previewPre.setAttribute('data-role', 'export-preview');

  const importStatusEl = el('div', 'hex-import-status', '');
  importStatusEl.setAttribute('data-role', 'import-status');

  root.appendChild(header);
  root.appendChild(tabs);
  root.appendChild(previewPre);
  root.appendChild(importStatusEl);

  function sync(snap) {
    root.setAttribute('data-open', snap.open ? 'true' : 'false');
    root.setAttribute('data-format', snap.format);
    for (const [fmt, btn] of tabButtons.entries()) {
      btn.setAttribute('aria-pressed', String(fmt === snap.format));
    }
    previewPre.textContent = snap.previewText;
    if (!snap.importStatus) {
      importStatusEl.textContent = '';
    } else if (snap.importStatus.ok) {
      importStatusEl.textContent = 'Import validated and applied.';
    } else {
      importStatusEl.textContent = `Import error: ${snap.importStatus.errors.join('; ')}`;
    }
  }

  sync(controller.getState());
  const unsubscribe = controller.subscribe(sync);
  return {
    element: root,
    destroy: () => {
      unsubscribe();
      ac.abort();
      root.remove?.();
    },
    sync: () => sync(controller.getState()),
  };
}
