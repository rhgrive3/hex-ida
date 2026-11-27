#!/usr/bin/env node
/**
 * Ghidra generic_clib_64.gdt + Real System POSIX/C11 Header Importer.
 * Parses Ghidra's PackedDatabase (Java ObjectOutputStream + raw DEFLATE + 16 KiB paged db.1.gbf B-Tree)
 * and optionally real /usr/include/ POSIX/C11 headers via c11-header-parser.js, producing a clean
 * deterministic gdtJsonToSdkIrUnit-compatible manifest and compiled TIL1 binary pack.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  TIL_PRIM,
  TIL_NS,
  HEX_KIND,
  HEX_SCALAR_AUX,
  TYPE_QUAL,
  CALL_CONV,
  SIG_FLAG,
  makeHexTypeId,
} from '../js/analysis/types/core/til-lite-data.js';
import {
  compileTil1,
  validateTil1Buffer,
} from '../js/analysis/types/core/til-binary-compiler.js';
import {
  parseLocalTypesHeader,
} from '../js/analysis/types/core/c11-header-parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export const DEFAULT_GDT_PATH = path.join(REPO_ROOT, 'third_party', 'ghidra-gdt', 'generic_clib_64.gdt');
export const MAX_GBF_OUTPUT_BYTES = 32 * 1024 * 1024; // 32 MiB Zip Bomb guard

// Real POSIX/C11 system headers to parse when includeSystemHeaders is enabled
export const DEFAULT_POSIX_HEADERS = [
  'stdio.h',
  'stdlib.h',
  'string.h',
  'unistd.h',
  'fcntl.h',
  'math.h',
  'time.h',
  'signal.h',
  'pthread.h',
  'dlfcn.h',
  'ctype.h',
  'wchar.h',
  'inttypes.h',
  'arpa/inet.h',
  'netdb.h',
  'sys/socket.h',
  'sys/stat.h',
  'sys/mman.h',
  'sys/types.h',
  'sys/select.h',
];

const INCLUDE_SEARCH_DIRS = [
  '/usr/include',
  '/usr/include/x86_64-linux-gnu',
  '/usr/include/aarch64-linux-gnu',
];

// Whitelist of real 1-2 character POSIX/libm C functions (all other 1-2 char names like cb, fn, fp are rejected)
const SHORT_PUBLIC_SYMBOL_WHITELIST = new Set([
  'j0', 'j1', 'jn', 'y0', 'y1', 'yn',
]);

const GBF_PAGE_SIZE = 16384;
const textDecoder = new TextDecoder('utf-8', { fatal: false });

function asciiCmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 1. Ghidra PackedDatabase (.gdt) -> Decompressed db.1.gbf B-Tree Reader
// ---------------------------------------------------------------------------
function decompressGdtToGbf(gdtBytes) {
  const buf = Buffer.isBuffer(gdtBytes) ? gdtBytes : Buffer.from(gdtBytes);
  const pkOff = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (pkOff < 0 || pkOff + 30 > buf.length) {
    throw new Error('Invalid Ghidra .gdt: embedded ZIP local header (PK\\x03\\x04) not found');
  }
  const method = buf.readUInt16LE(pkOff + 8);
  const nameLen = buf.readUInt16LE(pkOff + 26);
  const extraLen = buf.readUInt16LE(pkOff + 28);
  const dataStart = pkOff + 30 + nameLen + extraLen;
  if (dataStart >= buf.length) {
    throw new Error('Invalid Ghidra .gdt: truncated ZIP entry header');
  }
  if (method === 0) {
    if (buf.length - dataStart > MAX_GBF_OUTPUT_BYTES) {
      throw new Error(`Ghidra .gdt uncompressed payload exceeds ${MAX_GBF_OUTPUT_BYTES} bytes`);
    }
    return buf.subarray(dataStart);
  }
  if (method !== 8) {
    throw new Error(`Unsupported Ghidra .gdt compression method: ${method}`);
  }
  // Raw DEFLATE stream with strict 32 MiB Zip Bomb output cap
  return zlib.inflateRawSync(buf.subarray(dataStart), {
    maxOutputLength: MAX_GBF_OUTPUT_BYTES,
  });
}

function readGbfTables(gbfBuf) {
  if (!gbfBuf || gbfBuf.length < 24) {
    throw new Error('Invalid Ghidra .gbf: buffer too small for header');
  }
  const rawPageSize = gbfBuf.readUInt32BE(20);
  const pageSize = rawPageSize || GBF_PAGE_SIZE;
  if (pageSize < 4096 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) {
    throw new Error(`Invalid Ghidra .gbf page size: ${pageSize}`);
  }
  const totalPages = Math.floor(gbfBuf.length / pageSize);
  if (totalPages < 2) {
    throw new Error(`Invalid Ghidra .gbf: too few pages (${totalPages})`);
  }

  function getBuf(bufId) {
    if (!Number.isInteger(bufId)) return null;
    const pageIdx = bufId + 1;
    if (pageIdx < 0 || pageIdx >= totalPages) return null;
    const start = pageIdx * pageSize;
    if (start + pageSize > gbfBuf.length || pageSize <= 5) return null;
    // Strip 5-byte LocalBufferFile prefix (1B empty flag + 4B bufferId)
    return gbfBuf.subarray(start + 5, start + pageSize);
  }

  function computeFixedRecSize(fieldTypes) {
    if (!Array.isArray(fieldTypes)) return -1;
    let total = 0;
    for (const ft of fieldTypes) {
      if (ft === 0 || ft === 6) total += 1;
      else if (ft === 1) total += 2;
      else if (ft === 2) total += 4;
      else if (ft === 3) total += 8;
      else return -1; // variable-length field
    }
    return total;
  }

  function walkLongKeyTable(rootBufId, fieldTypes = null) {
    if (rootBufId < 0) return [];
    let b = getBuf(rootBufId);
    if (!b || b.length < 13) return [];

    // Descend interior nodes (nodeType === 0) to leftmost leaf (nodeType === 1)
    let guard = 0;
    while (b && b[0] === 0 && guard++ < 16) {
      if (b.length < 17) return [];
      const childId = b.readInt32BE(5 + 8);
      b = getBuf(childId);
    }

    const rows = [];
    const visited = new Set();
    const fixedRecLen = computeFixedRecSize(fieldTypes);
    while (b && b.length >= 13 && (b[0] === 1 || b[0] === 2)) {
      const nodeType = b[0];
      const keyCount = b.readUInt32BE(1);
      const nextId = b.readInt32BE(9);

      if (nodeType === 1) {
        const maxKeys = Math.floor((b.length - 13) / 13);
        if (keyCount > maxKeys) break;
        for (let i = 0; i < keyCount; i++) {
          const e = 13 + i * 13;
          if (e + 13 > b.length) break;
          const key = b.readBigInt64BE(e);
          const off = b.readUInt32BE(e + 8);
          const ind = b[e + 12];
          const end = i > 0 ? b.readUInt32BE(13 + (i - 1) * 13 + 8) : b.length;
          if (ind === 0 && off <= end && end <= b.length) {
            rows.push({ key, rec: b.subarray(off, end) });
          }
        }
      } else if (nodeType === 2 && fixedRecLen > 0) {
        const entryStride = 8 + fixedRecLen;
        const maxKeys = Math.floor((b.length - 13) / entryStride);
        if (keyCount > maxKeys) break;
        for (let i = 0; i < keyCount; i++) {
          const e = 13 + i * entryStride;
          if (e + entryStride > b.length) break;
          const key = b.readBigInt64BE(e);
          rows.push({ key, rec: b.subarray(e + 8, e + entryStride) });
        }
      } else {
        break;
      }

      if (nextId < 0 || visited.has(nextId)) break;
      visited.add(nextId);
      b = getBuf(nextId);
    }
    return rows;
  }

  function decodeRecord(rec, fieldTypes) {
    const vals = [];
    let p = 0;
    for (const ft of fieldTypes) {
      if (ft === 0) {
        if (p + 1 > rec.length) break;
        vals.push(rec.readInt8(p)); p += 1;
      } else if (ft === 1) {
        if (p + 2 > rec.length) break;
        vals.push(rec.readInt16BE(p)); p += 2;
      } else if (ft === 2) {
        if (p + 4 > rec.length) break;
        vals.push(rec.readInt32BE(p)); p += 4;
      } else if (ft === 3) {
        if (p + 8 > rec.length) break;
        vals.push(rec.readBigInt64BE(p)); p += 8;
      } else if (ft === 4) {
        if (p + 4 > rec.length) break;
        const slen = rec.readInt32BE(p); p += 4;
        if (slen < 0) {
          vals.push(null);
        } else {
          if (p + slen > rec.length) break;
          vals.push(textDecoder.decode(rec.subarray(p, p + slen)));
          p += slen;
        }
      } else if (ft === 5) {
        if (p + 4 > rec.length) break;
        const blen = rec.readInt32BE(p); p += 4;
        if (blen < 0) {
          vals.push(null);
        } else {
          if (p + blen > rec.length) break;
          vals.push(rec.subarray(p, p + blen));
          p += blen;
        }
      } else if (ft === 6) {
        if (p + 1 > rec.length) break;
        vals.push(rec[p] !== 0); p += 1;
      } else {
        break;
      }
    }
    return vals;
  }

  // Master table lives at bufferId = 1
  const masterRows = walkLongKeyTable(1);
  const tables = new Map();
  for (const { rec } of masterRows) {
    if (rec.length < 18) continue;
    const nameLen = rec.readUInt32BE(0);
    if (nameLen > rec.length || 4 + nameLen + 13 > rec.length) continue;
    const tableName = textDecoder.decode(rec.subarray(4, 4 + nameLen));
    const r = rec.subarray(4 + nameLen);
    if (r.length < 13) continue;
    const rootId = r.readInt32BE(4);
    const keyType = r[8];
    if (keyType !== 3) continue; // skip index tables (0x33)
    const numFields = r.readUInt32BE(9);
    if (13 + numFields > r.length) continue;
    const fieldTypes = Array.from(r.subarray(13, 13 + numFields));
    tables.set(tableName, {
      rootId,
      fieldTypes,
      readAll: () => walkLongKeyTable(rootId, fieldTypes).map(({ key, rec: rowRec }) => ({
        key,
        fields: decodeRecord(rowRec, fieldTypes),
      })),
    });
  }
  return tables;
}

const GHIDRA_BUILTIN_TO_C = new Map([
  ['void', 'void'],
  ['bool', 'bool'],
  ['char', 'char'],
  ['uchar', 'uint8_t'],
  ['schar', 'int8_t'],
  ['short', 'int16_t'],
  ['ushort', 'uint16_t'],
  ['int', 'int'],
  ['uint', 'unsigned int'],
  ['long', 'long'],
  ['ulong', 'uint64_t'],
  ['longlong', 'int64_t'],
  ['ulonglong', 'uint64_t'],
  ['float', 'float'],
  ['double', 'double'],
  ['longdouble', 'double'],
  ['wchar_t', 'int32_t'],
]);

/**
 * Parses Ghidra's generic_clib_64.gdt PackedDatabase into clean functions, structs, typedefs, and enums.
 * Automatically filters out function-pointer callback definitions referenced by the Pointers table.
 */
export function parseGhidraGdt(gdtPathOrBytes = DEFAULT_GDT_PATH) {
  const gdtBytes = typeof gdtPathOrBytes === 'string'
    ? fs.readFileSync(gdtPathOrBytes)
    : gdtPathOrBytes;
  const gbfBuf = decompressGdtToGbf(gdtBytes);
  const tables = readGbfTables(gbfBuf);

  const builtins = new Map();
  if (tables.has('Built-in datatypes')) {
    for (const { key, fields } of tables.get('Built-in datatypes').readAll()) {
      const name = fields[0] || 'void';
      builtins.set(key, GHIDRA_BUILTIN_TO_C.get(name) || name);
    }
  }

  const pointers = new Map();
  const pointedTypeIds = new Set();
  if (tables.has('Pointers')) {
    for (const { key, fields } of tables.get('Pointers').readAll()) {
      const targetId = fields[0];
      pointers.set(key, targetId);
      if (targetId !== null && targetId !== undefined) {
        pointedTypeIds.add(targetId);
      }
    }
  }

  const arrays = new Map();
  if (tables.has('Arrays')) {
    for (const { key, fields } of tables.get('Arrays').readAll()) {
      arrays.set(key, { elemId: fields[0], dim: fields[1], len: fields[2] });
    }
  }

  const typedefByKey = new Map();
  if (tables.has('Typedefs')) {
    for (const { key, fields } of tables.get('Typedefs').readAll()) {
      typedefByKey.set(key, { targetId: fields[0], name: fields[2] });
      if (fields[0] !== null && fields[0] !== undefined && (fields[0] >> 56n) === 6n) {
        pointedTypeIds.add(fields[0]);
      }
    }
  }

  const compositeByKey = new Map();
  if (tables.has('Composite Data Types')) {
    for (const { key, fields } of tables.get('Composite Data Types').readAll()) {
      const name = fields[0];
      if (!name) continue;
      compositeByKey.set(key, {
        name,
        isUnion: Boolean(fields[2]),
        size: Number(fields[4] || 0),
        members: [],
      });
    }
  }

  const enumByKey = new Map();
  if (tables.has('Enumeration Data Types')) {
    for (const { key, fields } of tables.get('Enumeration Data Types').readAll()) {
      const name = fields[0];
      if (!name || name.startsWith('define_')) continue;
      enumByKey.set(key, {
        name,
        size: Number(fields[3] || 4),
        items: [],
      });
    }
  }

  if (tables.has('Enumeration Values')) {
    for (const { fields } of tables.get('Enumeration Values').readAll()) {
      const name = fields[0];
      const value = Number(fields[1] ?? 0);
      const enumId = fields[2];
      const e = enumByKey.get(enumId);
      if (e && name) {
        e.items.push({ name, value });
      }
    }
  }

  function resolveTypeId(dtId, depth = 0) {
    if (dtId === null || dtId === undefined || dtId < 0n || depth > 8) return 'void';
    if (builtins.has(dtId)) return builtins.get(dtId);
    if (pointers.has(dtId)) {
      const inner = resolveTypeId(pointers.get(dtId), depth + 1);
      return `${inner}*`;
    }
    if (arrays.has(dtId)) {
      const inner = resolveTypeId(arrays.get(dtId).elemId, depth + 1);
      return `${inner}*`;
    }
    if (typedefByKey.has(dtId)) {
      const td = typedefByKey.get(dtId);
      if (td.name && ['size_t', 'ssize_t', 'off_t', 'time_t', 'pid_t', 'uid_t', 'gid_t', 'mode_t', 'socklen_t', 'int8_t', 'uint8_t', 'int16_t', 'uint16_t', 'int32_t', 'uint32_t', 'int64_t', 'uint64_t', 'intptr_t', 'uintptr_t', 'FILE', 'DIR', 'pthread_t'].includes(td.name)) {
        return td.name;
      }
      return resolveTypeId(td.targetId, depth + 1);
    }
    if (compositeByKey.has(dtId)) {
      return compositeByKey.get(dtId).name;
    }
    if (enumByKey.has(dtId)) {
      return enumByKey.get(dtId).name;
    }
    return 'void*';
  }

  if (tables.has('Component Data Types')) {
    for (const { fields } of tables.get('Component Data Types').readAll()) {
      const parentId = fields[0];
      const offset = Number(fields[1] || 0);
      const dtId = fields[2];
      const fieldName = fields[3];
      const comp = compositeByKey.get(parentId);
      if (comp && fieldName) {
        comp.members.push({
          offset,
          name: fieldName,
          type: resolveTypeId(dtId),
          size: Number(fields[5] || 0) || 8,
        });
      }
    }
  }

  const paramsByFn = new Map();
  if (tables.has('Function Parameters')) {
    for (const { fields } of tables.get('Function Parameters').readAll()) {
      const parentId = fields[0];
      const dtId = fields[1];
      const pName = fields[2] || '';
      const ordinal = Number(fields[4] ?? 0);
      if (!paramsByFn.has(parentId)) paramsByFn.set(parentId, []);
      paramsByFn.get(parentId).push({
        ordinal,
        name: pName,
        type: resolveTypeId(dtId),
      });
    }
  }

  const functions = [];
  let skippedCallbackDefs = 0;
  if (tables.has('Function Definitions')) {
    for (const { key, fields } of tables.get('Function Definitions').readAll()) {
      const name = fields[0];
      if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      // Exclude function-pointer callback typedef definitions referenced by the Pointers table
      if (pointedTypeIds.has(key)) {
        skippedCallbackDefs++;
        continue;
      }
      const retType = resolveTypeId(fields[3]);
      const flags = Number(fields[4] || 0);
      const isVariadic = (flags & 1) !== 0;
      const rawParams = paramsByFn.get(key) || [];
      rawParams.sort((a, b) => a.ordinal - b.ordinal);
      const cleanedParams = rawParams
        .slice(0, 12)
        .filter((p) => p.type !== 'void')
        .map((p) => ({ name: p.name, type: p.type }));
      functions.push({
        name,
        returnType: retType,
        params: cleanedParams,
        isVariadic,
        source: 'ghidra-gdt',
      });
    }
  }

  const structs = [];
  for (const comp of compositeByKey.values()) {
    if (!comp.isUnion && /^[A-Za-z_][A-Za-z0-9_]*$/.test(comp.name) && comp.size > 0) {
      comp.members.sort((a, b) => a.offset - b.offset);
      structs.push({
        name: comp.name,
        size: comp.size,
        members: comp.members.slice(0, 64),
      });
    }
  }

  const typedefs = [];
  for (const td of typedefByKey.values()) {
    if (td.name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(td.name)) {
      typedefs.push({
        name: td.name,
        target: resolveTypeId(td.targetId),
      });
    }
  }

  const enums = [];
  for (const e of enumByKey.values()) {
    if (e.items.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name)) {
      const nonZero = e.items.filter((it) => it.value > 0);
      const isBitmask = nonZero.length >= 2 && nonZero.every((it) => (it.value & (it.value - 1)) === 0);
      enums.push({
        name: e.name,
        isBitmask,
        items: e.items.slice(0, 64),
      });
    }
  }

  return {
    source: 'generic_clib_64.gdt',
    skippedCallbackDefs,
    functions,
    structs,
    typedefs,
    enums,
  };
}

// ---------------------------------------------------------------------------
// 2. Real System /usr/include/ POSIX/C11 Header Extractor (via c11-header-parser)
// ---------------------------------------------------------------------------
function resolveSystemHeaderPath(relHeader, searchDirs = INCLUDE_SEARCH_DIRS) {
  for (const dir of searchDirs) {
    const candidate = path.join(dir, relHeader);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function normalizeGlibcHeaderForC11Parser(raw) {
  return raw
    .replace(/__attribute_malloc__|__attribute_pure__|__attribute_const__|__attribute_deprecated__|__attribute_warn_unused_result__/g, '')
    .replace(/__attribute_alloc_size__\s*\([^)]*\)/g, '')
    .replace(/__attribute_format_arg__\s*\([^)]*\)/g, '')
    .replace(/__attribute_format_strfmon__\s*\([^)]*\)/g, '')
    .replace(/__attr_access\s*\([^)]*\)/g, '')
    .replace(/__attr_dealloc(?:_free|_fclose)?(?:\s*\([^)]*\))?/g, '')
    .replace(/__nonnull\s*\(\([^)]*\)\)/g, '')
    .replace(/__nonnull\s*\([^)]*\)/g, '')
    .replace(/__fortified_attr_access\s*\([^)]*\)/g, '')
    .replace(/__THROW|__THROWNL|__wur|__NTH|__BEGIN_DECLS|__END_DECLS|__extern_inline|__extern_always_inline/g, '')
    .replace(/__extension__|__restrict_arr|__restrict/g, '')
    .replace(/\b__off64_t\b|\b__off_t\b/g, 'int64_t')
    .replace(/\b__ssize_t\b/g, 'ssize_t')
    .replace(/\b__time_t\b/g, 'time_t')
    .replace(/\b__pid_t\b/g, 'pid_t')
    .replace(/\b__uid_t\b/g, 'uid_t')
    .replace(/\b__gid_t\b/g, 'gid_t')
    .replace(/\b__mode_t\b/g, 'mode_t')
    .replace(/\b__socklen_t\b/g, 'socklen_t')
    .replace(/\b__uint32_t\b/g, 'uint32_t')
    .replace(/\b__uint16_t\b/g, 'uint16_t')
    .replace(/\b__uint64_t\b/g, 'uint64_t')
    .replace(/\b__int64_t\b/g, 'int64_t')
    .replace(/\b__int32_t\b/g, 'int32_t')
    .replace(/\b__gnuc_va_list\b/g, 'va_list');
}

function typeRefToString(t) {
  if (!t) return 'void';
  const base = t.name || 'void';
  const prefix = t.isConst ? 'const ' : '';
  const stars = t.ptrDepth > 0 ? '*'.repeat(t.ptrDepth) : '';
  return `${prefix}${base}${stars}`;
}

export function parseSystemPosixHeaders({
  headers = DEFAULT_POSIX_HEADERS,
  searchDirs = INCLUDE_SEARCH_DIRS,
} = {}) {
  const functions = new Map();
  const structs = new Map();
  const typedefs = new Map();
  const enums = new Map();
  const parsedFiles = [];

  for (const rel of headers) {
    const abs = resolveSystemHeaderPath(rel, searchDirs);
    if (!abs) continue;
    const raw = fs.readFileSync(abs, 'utf8');
    const cleaned = normalizeGlibcHeaderForC11Parser(raw);
    const parsed = parseLocalTypesHeader(cleaned);
    parsedFiles.push(abs);

    for (const f of parsed.functions) {
      if (!f.name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.name)) continue;
      if (f.name.startsWith('__REDIRECT') || f.name.startsWith('__MATH')) continue;
      if (!functions.has(f.name)) {
        functions.set(f.name, {
          name: f.name,
          returnType: typeRefToString(f.retType),
          params: f.params
            .slice(0, 12)
            .map((p) => ({ name: p.name, type: typeRefToString(p.type) }))
            .filter((p) => p.type !== 'void'),
          isVariadic: Boolean(f.isVariadic),
          source: `posix:${rel}`,
        });
      }
    }
    for (const [name, s] of parsed.structs.entries()) {
      if (!name.startsWith('__anon_') && s.layoutState === 'defined' && s.size > 0 && !structs.has(name)) {
        structs.set(name, {
          name,
          size: s.size,
          members: s.members.map((m) => ({
            offset: m.offset,
            name: m.name,
            type: typeRefToString(m.type),
            size: m.size,
            bfLsb: m.bfLsb || 0,
            bfWidth: m.bfWidth || 0,
          })),
        });
      }
    }
    for (const [name, td] of parsed.typedefs.entries()) {
      if (!name.startsWith('__') && !typedefs.has(name)) {
        typedefs.set(name, { name, target: typeRefToString(td) });
      }
    }
    for (const [name, e] of parsed.enums.entries()) {
      if (!name.startsWith('__anon_') && e.items.length > 0 && !enums.has(name)) {
        enums.set(name, { name, isBitmask: e.isBitmask, items: e.items });
      }
    }
  }

  return {
    parsedFiles,
    functions: Array.from(functions.values()),
    structs: Array.from(structs.values()),
    typedefs: Array.from(typedefs.values()),
    enums: Array.from(enums.values()),
  };
}

// ---------------------------------------------------------------------------
// 3. Merge Ghidra GDT + Optional System POSIX Headers -> Deterministic Manifest
// ---------------------------------------------------------------------------
export function isCleanPublicSymbol(name) {
  if (!name || name.length > 48) return false;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
  // Reject 1-2 character callback/placeholder names unless in real POSIX/libm whitelist
  if (name.length <= 2) {
    return SHORT_PUBLIC_SYMBOL_WHITELIST.has(name);
  }
  if (name.startsWith('__')) {
    return /^__(?:cxa_|errno_location|assert_fail|stack_chk_fail|memcpy_chk|memmove_chk|memset_chk|strcpy_chk|strncpy_chk|snprintf_chk|android_log_|xstat|fxstat|lxstat|isoc99_)/.test(name);
  }
  return true;
}

/**
 * Extracts and merges Ghidra generic_clib_64.gdt (default deterministic source)
 * and optionally host /usr/include POSIX headers (`includeSystemHeaders: true`)
 * into a deterministic gdtJsonToSdkIrUnit-compatible manifest.
 */
export function extractPosixAndGhidraManifest({
  gdtPath = DEFAULT_GDT_PATH,
  includeSystemHeaders = false,
  headers = DEFAULT_POSIX_HEADERS,
  searchDirs = INCLUDE_SEARCH_DIRS,
  maxFunctions = 2800,
  maxStructs = 400,
  maxTypedefs = 300,
  maxEnums = 120,
} = {}) {
  const gdtData = fs.existsSync(gdtPath)
    ? parseGhidraGdt(gdtPath)
    : { functions: [], structs: [], typedefs: [], enums: [], skippedCallbackDefs: 0 };

  const posixData = includeSystemHeaders
    ? parseSystemPosixHeaders({ headers, searchDirs })
    : { parsedFiles: [], functions: [], structs: [], typedefs: [], enums: [] };

  const fnMap = new Map();
  for (const f of posixData.functions) {
    if (isCleanPublicSymbol(f.name) && !fnMap.has(f.name)) {
      fnMap.set(f.name, f);
    }
  }
  for (const f of gdtData.functions) {
    if (isCleanPublicSymbol(f.name) && !fnMap.has(f.name)) {
      fnMap.set(f.name, f);
    }
  }

  // Deterministic ASCII priority sort: POSIX headers -> lowercase libc/POSIX (a-z) -> uppercase/prefixed APIs
  const priorityRank = (f) => {
    if (f.source.startsWith('posix:')) return 0;
    if (/^[a-z]/.test(f.name)) return 1;
    return 2;
  };
  const allFuncs = Array.from(fnMap.values()).sort((a, b) => {
    const ra = priorityRank(a);
    const rb = priorityRank(b);
    if (ra !== rb) return ra - rb;
    return asciiCmp(a.name, b.name);
  });
  const selectedFunctions = allFuncs.slice(0, maxFunctions);

  const structMap = new Map();
  for (const s of [...posixData.structs, ...gdtData.structs]) {
    if (!s.name || s.name.startsWith('__') || s.name.length > 48) continue;
    if (!structMap.has(s.name)) structMap.set(s.name, s);
  }
  const selectedStructs = Array.from(structMap.values())
    .sort((a, b) => asciiCmp(a.name, b.name))
    .slice(0, maxStructs);

  const tdMap = new Map();
  for (const td of [...posixData.typedefs, ...gdtData.typedefs]) {
    if (!td.name || td.name.startsWith('__') || td.name.length > 48) continue;
    if (!structMap.has(td.name) && !tdMap.has(td.name)) tdMap.set(td.name, td);
  }
  const selectedTypedefs = Array.from(tdMap.values())
    .sort((a, b) => asciiCmp(a.name, b.name))
    .slice(0, maxTypedefs);

  const enumMap = new Map();
  for (const e of [...posixData.enums, ...gdtData.enums]) {
    if (!e.name || e.name.startsWith('__') || e.name.length > 48) continue;
    if (!structMap.has(e.name) && !tdMap.has(e.name) && !enumMap.has(e.name)) {
      enumMap.set(e.name, e);
    }
  }
  const selectedEnums = Array.from(enumMap.values())
    .sort((a, b) => asciiCmp(a.name, b.name))
    .slice(0, maxEnums);

  return {
    schema: 'hex-gdt-manifest/v1',
    name: 'posix-clib-full',
    moduleName: 'posix-clib-full',
    sources: {
      ghidraGdt: fs.existsSync(gdtPath) ? path.basename(gdtPath) : null,
      ghidraRawFunctions: gdtData.functions.length,
      ghidraSkippedCallbackDefs: gdtData.skippedCallbackDefs || 0,
      ghidraRawStructs: gdtData.structs.length,
      includeSystemHeaders: Boolean(includeSystemHeaders),
      posixHeadersParsed: posixData.parsedFiles.length,
      posixRawFunctions: posixData.functions.length,
    },
    structs: selectedStructs,
    enums: selectedEnums,
    typedefs: selectedTypedefs,
    functions: selectedFunctions,
  };
}

// ---------------------------------------------------------------------------
// 4. Compile Manifest -> Compact TIL1 Binary (fits comfortably in WASM Slot 1/2 <= 256 KiB)
// ---------------------------------------------------------------------------
const C_PRIM_MAP = new Map([
  ['void', TIL_PRIM.VOID],
  ['bool', TIL_PRIM.BOOL],
  ['_Bool', TIL_PRIM.BOOL],
  ['char', TIL_PRIM.I8],
  ['int8_t', TIL_PRIM.I8],
  ['uint8_t', TIL_PRIM.U8],
  ['unsigned char', TIL_PRIM.U8],
  ['short', TIL_PRIM.I16],
  ['int16_t', TIL_PRIM.I16],
  ['uint16_t', TIL_PRIM.U16],
  ['unsigned short', TIL_PRIM.U16],
  ['int', TIL_PRIM.I32],
  ['int32_t', TIL_PRIM.I32],
  ['pid_t', TIL_PRIM.I32],
  ['unsigned int', TIL_PRIM.U32],
  ['uint32_t', TIL_PRIM.U32],
  ['uid_t', TIL_PRIM.U32],
  ['gid_t', TIL_PRIM.U32],
  ['mode_t', TIL_PRIM.U32],
  ['socklen_t', TIL_PRIM.U32],
  ['long', TIL_PRIM.I64],
  ['int64_t', TIL_PRIM.I64],
  ['ssize_t', TIL_PRIM.I64],
  ['off_t', TIL_PRIM.I64],
  ['time_t', TIL_PRIM.I64],
  ['intptr_t', TIL_PRIM.I64],
  ['uint64_t', TIL_PRIM.U64],
  ['unsigned long', TIL_PRIM.U64],
  ['size_t', TIL_PRIM.U64],
  ['uintptr_t', TIL_PRIM.U64],
  ['pthread_t', TIL_PRIM.U64],
  ['float', TIL_PRIM.F32],
  ['double', TIL_PRIM.F64],
]);

const VOID_NON_PTR_HEX = makeHexTypeId({ baseTilId: TIL_PRIM.VOID }); // 0x00000001
const U64_FALLBACK_HEX = makeHexTypeId({ baseTilId: TIL_PRIM.U64 });

function cTypeStringToHex(typeStr, typeNameToInfo, { isParam = false } = {}) {
  let s = String(typeStr || 'void').trim();
  let isConst = false;
  if (s.startsWith('const ')) {
    isConst = true;
    s = s.slice(6).trim();
  }
  let ptrDepth = 0;
  while (s.endsWith('*')) {
    ptrDepth++;
    s = s.slice(0, -1).trim();
  }
  if (s.startsWith('const ')) {
    isConst = true;
    s = s.slice(6).trim();
  }
  s = s.replace(/^(?:struct|union|enum)\s+/, '').trim();

  if (C_PRIM_MAP.has(s)) {
    const prim = C_PRIM_MAP.get(s);
    if (isParam && ptrDepth === 0 && prim === TIL_PRIM.VOID) {
      return U64_FALLBACK_HEX;
    }
    return makeHexTypeId({ baseTilId: prim, ptrDepth, isConst });
  }

  if (typeNameToInfo.has(s)) {
    const info = typeNameToInfo.get(s);
    return makeHexTypeId({
      baseTilId: info.tid,
      ptrDepth,
      isConst,
      kindTag: info.kind,
      auxMeta: ptrDepth === 0 ? (info.auxMeta || 0) : 0,
    });
  }

  // Unresolved type handling
  if (isParam && ptrDepth === 0) {
    // Function-pointer typedef names -> FUNC_PTR
    if (/(?:_fn(?:_t)?|_func(?:_t)?|_cb(?:_t)?|callback|handler|proc)$/i.test(s)) {
      return makeHexTypeId({
        baseTilId: TIL_PRIM.VOID,
        ptrDepth: 1,
        isConst,
        kindTag: HEX_KIND.FUNC_PTR,
      });
    }
    // Never emit non-pointer TIL_PRIM.VOID (0x1) in paramHexTypes!
    return makeHexTypeId({ baseTilId: TIL_PRIM.U64, isConst });
  }

  return makeHexTypeId({ baseTilId: TIL_PRIM.VOID, ptrDepth, isConst });
}

/**
 * Compiles a hex-gdt-manifest/v1 object directly into a verified TIL1 binary buffer.
 */
export function compileGdtManifestToTil1(manifest, {
  packId = manifest.name || 'posix-clib-full',
  includeExtChunk = true,
  maxExtLayouts = 120,
  maxExtEnums = 60,
} = {}) {
  let nextTid = TIL_NS.PACK_MIN;
  const typeNameToInfo = new Map(); // name -> { tid, kind, auxMeta }
  const types = [];
  const structLayouts = [];
  const enums = [];

  for (const s of (manifest.structs || [])) {
    if (!s || !s.name || typeNameToInfo.has(s.name)) continue;
    const tid = nextTid++;
    typeNameToInfo.set(s.name, { tid, kind: HEX_KIND.STRUCT, auxMeta: 0 });
    types.push({
      tid,
      name: s.name,
      kind: HEX_KIND.STRUCT,
      bits: Math.min(255, (s.size || 0) * 8),
      qualifiers: 0,
      pointeeTid: 0,
    });
  }

  for (const e of (manifest.enums || [])) {
    if (!e || !e.name || typeNameToInfo.has(e.name)) continue;
    const tid = nextTid++;
    const auxMeta = e.isBitmask ? HEX_SCALAR_AUX.BITMASK : HEX_SCALAR_AUX.ENUM;
    typeNameToInfo.set(e.name, { tid, kind: HEX_KIND.SCALAR, auxMeta });
    types.push({
      tid,
      name: e.name,
      kind: HEX_KIND.SCALAR,
      bits: 32,
      qualifiers: TYPE_QUAL.SIGNED | (e.isBitmask ? TYPE_QUAL.BITMASK : TYPE_QUAL.ENUM),
      pointeeTid: TIL_PRIM.I32,
    });
    if (includeExtChunk && enums.length < maxExtEnums) {
      enums.push({ tid, name: e.name, items: (e.items || []).slice(0, 32) });
    }
  }

  for (const td of (manifest.typedefs || [])) {
    if (!td || !td.name || typeNameToInfo.has(td.name)) continue;
    const tid = nextTid++;
    const targetHex = cTypeStringToHex(td.target || 'void', typeNameToInfo);
    const inheritedKind = (targetHex >>> 21) & 0x07;
    const inheritedAux = (targetHex >>> 24) & 0xFF;
    typeNameToInfo.set(td.name, { tid, kind: inheritedKind, auxMeta: inheritedAux });
    types.push({
      tid,
      name: td.name,
      kind: inheritedKind,
      bits: 64,
      qualifiers: 0,
      pointeeTid: targetHex & 0xFFFF,
    });
  }

  if (includeExtChunk) {
    for (const s of (manifest.structs || [])) {
      if (structLayouts.length >= maxExtLayouts) break;
      if (!s || !s.name || !Array.isArray(s.members) || s.members.length === 0) continue;
      const info = typeNameToInfo.get(s.name);
      if (!info) continue;
      structLayouts.push({
        tid: info.tid,
        name: s.name,
        totalSize: s.size || 0,
        members: s.members.slice(0, 24).map((m) => ({
          offset: m.offset || 0,
          name: m.name || '',
          hexType: cTypeStringToHex(m.type || 'uint8_t', typeNameToInfo, { isParam: true }),
          size: m.size || 0,
          bfLsb: m.bfLsb || 0,
          bfWidth: m.bfWidth || 0,
        })),
      });
    }
  }

  const functions = (manifest.functions || []).map((f) => {
    const paramHexTypes = (f.params || []).slice(0, 12).map((p) => {
      const hex = cTypeStringToHex(typeof p === 'object' ? p.type : p, typeNameToInfo, { isParam: true });
      // Hard guard: never emit non-pointer TIL_PRIM.VOID (0x1) in paramHexTypes
      return hex === VOID_NON_PTR_HEX ? U64_FALLBACK_HEX : hex;
    });
    return {
      name: f.name,
      retHexType: cTypeStringToHex(f.returnType || 'void', typeNameToInfo, { isParam: false }),
      paramHexTypes,
      flags: f.isVariadic ? SIG_FLAG.VARIADIC : 0,
      fmtArgIdx: 0xFF,
      callConv: CALL_CONV.AAPCS64,
    };
  });

  const tilBytes = compileTil1({
    packId,
    isCore: false,
    localTidRelative: true,
    types,
    functions,
    selectors: [],
    enums,
    structLayouts,
  });

  const val = validateTil1Buffer(tilBytes);
  if (!val.ok) {
    throw new Error(`compileGdtManifestToTil1: invalid TIL1 output: ${val.error}`);
  }

  return {
    tilBytes,
    header: val.header,
  };
}

// CLI execution
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  const includeSystemHeaders = process.argv.includes('--include-system-headers');
  const manifest = extractPosixAndGhidraManifest({ includeSystemHeaders });
  const { tilBytes, header } = compileGdtManifestToTil1(manifest);
  console.log(
    `[import-ghidra-gdt] Extracted ${manifest.functions.length} functions, ` +
    `${manifest.structs.length} structs, ${manifest.typedefs.length} typedefs, ${manifest.enums.length} enums ` +
    `(GDT raw: ${manifest.sources.ghidraRawFunctions} funcs, skipped callbacks: ${manifest.sources.ghidraSkippedCallbackDefs}, ` +
    `POSIX headers: ${manifest.sources.posixHeadersParsed} files)`
  );
  console.log(
    `[import-ghidra-gdt] Compiled TIL1: ${tilBytes.byteLength}B ` +
    `(entries=${header.entryCount}, types=${header.typeCount}, fnv32=0x${header.checksumFnv32.toString(16)})`
  );
}
