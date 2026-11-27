/**
 * SDK Batch Compiler: compiles mixed C headers (.h/.hpp), Apple .tbd stubs,
 * Swift .swiftinterface files, and OSS JSON / GDT-exported type manifests
 * (or .zip archives) into compressed TIL1 packs with dependency-ordered compilation,
 * Tarjan SCC cycle handling, pre-inflation Zip Bomb/symlink/traversal defense,
 * and multi-chunk local TID rebasing to TIL_NS.PACK_MIN (0x1000).
 * Spec: hex_ida_beyond_ida_design.md §18.3
 * INV-005: ZERO imports from js/targets/architecture/.
 */

import {
  TIL_PRIM,
  TIL_NS,
  HEX_KIND,
  TYPE_QUAL,
  CALL_CONV,
  SIG_FLAG,
  makeHexTypeId,
} from './til-lite-data.js';
import { compileTil1, validateTil1Buffer } from './til-binary-compiler.js';
import { parseLocalTypesHeader, compileParsedHeaderToIr } from './c11-header-parser.js';
import { parseTbd, tbdToSdkIrUnit } from './tbd-parser.js';
import { parseSwiftInterface, swiftInterfaceToSdkIrUnit } from './swiftinterface-parser.js';
import { sha256HexSync } from './til-storage.js';

export const BATCH_SECURITY_LIMITS = Object.freeze({
  MAX_FILES: 4096,
  MAX_SINGLE_FILE_BYTES: 16 * 1024 * 1024,
  MAX_TOTAL_BYTES: 128 * 1024 * 1024,
  MAX_ZIP_RATIO: 100,
  ZIP_BOMB_MIN_BYTES: 32 * 1024 * 1024,
  MAX_INCLUDE_DEPTH: 32,
  MAX_TYPES_PER_PACK: 2560,
  MAX_ENTRIES_PER_PACK: 65535,
});

let cachedFflate = null;
async function getFflate(injected) {
  if (injected) return injected;
  if (!cachedFflate) {
    cachedFflate = await import('../../../vendor/fflate.js');
  }
  return cachedFflate;
}

/**
 * Validates a relative SDK file path against path traversal, absolute paths,
 * Windows drive letters, and NUL/control characters (§18.3).
 */
export function validateSdkFilePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return { ok: false, error: 'Empty file path' };
  }
  if (/[\x00-\x1f\x7f]/.test(filePath)) {
    return { ok: false, error: `Control or NUL character in path '${filePath}'` };
  }
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('/')) {
    return { ok: false, error: `Absolute path rejected: '${filePath}'` };
  }
  if (/^[A-Za-z]:/.test(normalized)) {
    return { ok: false, error: `Windows drive letter path rejected: '${filePath}'` };
  }
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      return { ok: false, error: `Path traversal '..' rejected: '${filePath}'` };
    }
  }
  return { ok: true, normalized };
}

/**
 * Scans the ZIP Central Directory before decompression to reject Unix symlinks (S_IFLNK = 0120000).
 */
export function assertNoZipSymlinks(bytes) {
  const len = bytes.byteLength;
  if (len < 22) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, len);

  // Locate End of Central Directory (PK\x05\x06)
  const searchStart = Math.max(0, len - 65557);
  let eocdOff = -1;
  for (let i = len - 22; i >= searchStart; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOff = i;
      break;
    }
  }
  if (eocdOff === -1) return;

  const cdSize = view.getUint32(eocdOff + 12, true);
  const cdOff = view.getUint32(eocdOff + 16, true);
  if (cdOff >= len || cdOff + cdSize > len) return;

  const decoder = new TextDecoder('utf-8');
  let pos = cdOff;
  const end = cdOff + cdSize;
  while (pos + 46 <= end) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const externalAttr = view.getUint32(pos + 38, true);
    const unixMode = (externalAttr >>> 16) & 0xFFFF;
    if ((unixMode & 0xF000) === 0xA000) {
      const name = pos + 46 + nameLen <= len
        ? decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen))
        : '<unknown>';
      throw new Error(`Security violation in ZIP: symlink (S_IFLNK) rejected for '${name}'`);
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
}

// ---------------------------------------------------------------------------
// OSS JSON / Ghidra GDT-exported manifest -> SdkIrUnit
// ---------------------------------------------------------------------------
const SIMPLE_TYPE_MAP = new Map([
  ['void', TIL_PRIM.VOID],
  ['bool', TIL_PRIM.BOOL],
  ['char', TIL_PRIM.I8],
  ['int8_t', TIL_PRIM.I8],
  ['uint8_t', TIL_PRIM.U8],
  ['int16_t', TIL_PRIM.I16],
  ['uint16_t', TIL_PRIM.U16],
  ['int', TIL_PRIM.I32],
  ['int32_t', TIL_PRIM.I32],
  ['uint32_t', TIL_PRIM.U32],
  ['unsigned int', TIL_PRIM.U32],
  ['long', TIL_PRIM.I64],
  ['int64_t', TIL_PRIM.I64],
  ['uint64_t', TIL_PRIM.U64],
  ['size_t', TIL_PRIM.U64],
  ['ssize_t', TIL_PRIM.I64],
  ['float', TIL_PRIM.F32],
  ['double', TIL_PRIM.F64],
  ['id', TIL_PRIM.OBJC_ID],
  ['SEL', TIL_PRIM.OBJC_SEL],
]);

function parseTypeStringToHex(typeStr, typeNameToTid) {
  if (typeof typeStr === 'number') return typeStr >>> 0;
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
  if (SIMPLE_TYPE_MAP.has(s)) {
    return makeHexTypeId({ baseTilId: SIMPLE_TYPE_MAP.get(s), ptrDepth, isConst });
  }
  if (typeNameToTid.has(s)) {
    return makeHexTypeId({ baseTilId: typeNameToTid.get(s), ptrDepth, isConst, kindTag: HEX_KIND.STRUCT });
  }
  return makeHexTypeId({ baseTilId: TIL_PRIM.VOID, ptrDepth, isConst });
}

export function gdtJsonToSdkIrUnit(jsonInput, { moduleName = 'oss-gdt', baseTid = TIL_NS.PACK_MIN } = {}) {
  const doc = typeof jsonInput === 'string' ? JSON.parse(jsonInput) : jsonInput;
  let nextTid = baseTid;
  const typeNameToTid = new Map();
  const types = [];
  const structLayouts = [];
  const enums = [];

  for (const s of (doc.structs || [])) {
    if (!s || !s.name) continue;
    const tid = nextTid++;
    typeNameToTid.set(s.name, tid);
    types.push({
      tid,
      name: s.name,
      kind: HEX_KIND.STRUCT,
      bits: Math.min(255, (s.size || 0) * 8),
      qualifiers: 0,
      pointeeTid: 0,
    });
  }

  for (const e of (doc.enums || [])) {
    if (!e || !e.name) continue;
    const tid = nextTid++;
    typeNameToTid.set(e.name, tid);
    types.push({
      tid,
      name: e.name,
      kind: HEX_KIND.SCALAR,
      bits: 32,
      qualifiers: TYPE_QUAL.SIGNED | (e.isBitmask ? TYPE_QUAL.BITMASK : TYPE_QUAL.ENUM),
      pointeeTid: TIL_PRIM.I32,
    });
    enums.push({
      tid,
      name: e.name,
      isBitmask: Boolean(e.isBitmask),
      items: (e.items || e.values || []).map((it) => ({
        name: it.name,
        value: Number(it.value ?? 0),
      })),
    });
  }

  for (const td of (doc.typedefs || [])) {
    if (!td || !td.name || typeNameToTid.has(td.name)) continue;
    const tid = nextTid++;
    const targetHex = parseTypeStringToHex(td.target || td.type || 'void', typeNameToTid);
    typeNameToTid.set(td.name, tid);
    types.push({
      tid,
      name: td.name,
      kind: (targetHex >>> 21) & 0x07,
      bits: 64,
      qualifiers: 0,
      pointeeTid: targetHex & 0xFFFF,
    });
  }

  for (const s of (doc.structs || [])) {
    if (!s || !s.name || !Array.isArray(s.members)) continue;
    const tid = typeNameToTid.get(s.name);
    structLayouts.push({
      tid,
      name: s.name,
      totalSize: s.size || 0,
      members: s.members.map((m) => ({
        offset: m.offset || 0,
        name: m.name || '',
        hexType: parseTypeStringToHex(m.type || 'uint8_t', typeNameToTid),
        size: m.size || 0,
        bfLsb: m.bfLsb || 0,
        bfWidth: m.bfWidth || 0,
      })),
    });
  }

  const functions = (doc.functions || []).filter((f) => f && f.name).map((f) => ({
    name: f.name,
    retHexType: parseTypeStringToHex(f.retHexType ?? f.returnType ?? 'void', typeNameToTid),
    paramHexTypes: (f.paramHexTypes || f.params || []).map((p) =>
      parseTypeStringToHex(typeof p === 'object' ? p.type : p, typeNameToTid)
    ),
    flags: (f.isVariadic ? SIG_FLAG.VARIADIC : 0) | (f.flags || 0),
    fmtArgIdx: f.fmtArgIdx !== undefined ? f.fmtArgIdx : 0xFF,
    callConv: f.callConv || CALL_CONV.AAPCS64,
  }));

  return {
    kind: 'gdt-json',
    moduleName: doc.moduleName || doc.name || moduleName,
    imports: doc.requires || [],
    types,
    functions,
    selectors: doc.selectors || [],
    enums,
    structLayouts,
  };
}

// ---------------------------------------------------------------------------
// Tarjan SCC + Topological Ordering over file dependencies
// ---------------------------------------------------------------------------
function topologicalOrderWithScc(nodes, getDeps) {
  let index = 0;
  const indices = new Map();
  const lowlink = new Map();
  const stack = [];
  const onStack = new Set();
  const sccs = [];

  function strongConnect(v) {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const w of getDeps(v)) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const scc = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  }

  for (const n of nodes) {
    if (!indices.has(n)) strongConnect(n);
  }
  const ordered = [];
  const cycles = [];
  for (const scc of sccs) {
    if (scc.length > 1) cycles.push(scc);
    for (const item of scc) ordered.push(item);
  }
  return { ordered, cycles };
}

/**
 * Extracts files from a ZIP archive with PRE-INFLATION path traversal, symlink (S_IFLNK),
 * file count, single/cumulative size, and Zip Bomb ratio validation (prevents OOM).
 */
export async function extractSdkZipFiles(zipBytes, {
  fflate = null,
  maxFiles = BATCH_SECURITY_LIMITS.MAX_FILES,
  maxSingleFileBytes = BATCH_SECURITY_LIMITS.MAX_SINGLE_FILE_BYTES,
  maxTotalBytes = BATCH_SECURITY_LIMITS.MAX_TOTAL_BYTES,
  maxZipRatio = BATCH_SECURITY_LIMITS.MAX_ZIP_RATIO,
  zipBombMinBytes = BATCH_SECURITY_LIMITS.ZIP_BOMB_MIN_BYTES,
} = {}) {
  const bytes = zipBytes instanceof Uint8Array ? zipBytes : new Uint8Array(zipBytes);
  // 1. Pre-scan Central Directory for Unix symlinks (S_IFLNK)
  assertNoZipSymlinks(bytes);

  const ff = await getFflate(fflate);
  let fileCount = 0;
  let totalOriginalBytes = 0;

  // 2. Pre-inflation filter runs BEFORE fflate allocates/inflates any entry
  const entries = ff.unzipSync(bytes, {
    filter(file) {
      if (file.name.endsWith('/')) return false; // skip directory entry
      const pathCheck = validateSdkFilePath(file.name);
      if (!pathCheck.ok) {
        throw new Error(`Security violation in ZIP: ${pathCheck.error}`);
      }
      fileCount++;
      if (fileCount > maxFiles) {
        throw new Error(`ZIP contains too many files (${fileCount} > ${maxFiles})`);
      }
      const origSize = file.originalSize >>> 0;
      const compSize = file.size >>> 0;
      if (origSize > maxSingleFileBytes) {
        throw new Error(`File '${file.name}' exceeds max single file size (${origSize} > ${maxSingleFileBytes})`);
      }
      totalOriginalBytes += origSize;
      if (totalOriginalBytes > maxTotalBytes) {
        throw new Error(`ZIP extracted size exceeds limit (${totalOriginalBytes} > ${maxTotalBytes})`);
      }
      if (
        (origSize > zipBombMinBytes && compSize > 0 && origSize / compSize > maxZipRatio) ||
        (totalOriginalBytes > zipBombMinBytes && bytes.byteLength > 0 && totalOriginalBytes / bytes.byteLength > maxZipRatio)
      ) {
        throw new Error(`Zip Bomb detected before inflation for '${file.name}' (ratio > ${maxZipRatio}:1)`);
      }
      return true;
    },
  });

  // 3. Post-inflation verification (defense in depth against spoofed ZIP headers)
  const decoder = new TextDecoder('utf-8');
  const files = [];
  let actualTotal = 0;
  for (const [rawName, contentBytes] of Object.entries(entries)) {
    const pathCheck = validateSdkFilePath(rawName);
    if (!pathCheck.ok) {
      throw new Error(`Security violation in ZIP: ${pathCheck.error}`);
    }
    if (contentBytes.byteLength > maxSingleFileBytes) {
      throw new Error(`File '${rawName}' actual size exceeds max single file size`);
    }
    actualTotal += contentBytes.byteLength;
    if (actualTotal > maxTotalBytes) {
      throw new Error(`ZIP actual extracted size exceeds ${maxTotalBytes} bytes`);
    }
    files.push({
      path: pathCheck.normalized,
      content: decoder.decode(contentBytes),
    });
  }

  return files;
}

// ---------------------------------------------------------------------------
// Multi-chunk splitting with transitive dependency closure & 0x1000 TID rebasing
// ---------------------------------------------------------------------------
function isPackLocalTid(tid) {
  const t = tid & 0xFFFF;
  return t >= TIL_NS.PACK_MIN && t <= TIL_NS.PACK_MAX;
}

function buildRebasedChunk({
  id,
  seedTypes,
  functions,
  selectors,
  allTypesByTid,
  allEnumsByTid,
  allLayoutsByTid,
}) {
  // 1. Collect all local TIDs referenced by seedTypes, functions, selectors, and transitively by layouts/pointeeTids
  const neededTids = new Set();
  const queue = [];

  const enqueueTid = (tid) => {
    const t = tid & 0xFFFF;
    if (isPackLocalTid(t) && !neededTids.has(t) && allTypesByTid.has(t)) {
      neededTids.add(t);
      queue.push(t);
    }
  };

  for (const t of seedTypes) enqueueTid(t.tid);
  for (const f of functions) {
    enqueueTid(f.retHexType & 0xFFFF);
    for (const p of (f.paramHexTypes || [])) enqueueTid(p & 0xFFFF);
  }
  for (const s of selectors) {
    enqueueTid(s.retHexType & 0xFFFF);
    for (const p of (s.paramHexTypes || [])) enqueueTid(p & 0xFFFF);
  }

  // Transitive closure over pointeeTid and structLayout member types
  while (queue.length > 0) {
    const curTid = queue.shift();
    const typeDesc = allTypesByTid.get(curTid);
    if (typeDesc && typeDesc.pointeeTid) {
      enqueueTid(typeDesc.pointeeTid);
    }
    const layout = allLayoutsByTid.get(curTid);
    if (layout) {
      for (const m of (layout.members || [])) {
        enqueueTid(m.hexType & 0xFFFF);
      }
    }
  }

  // 2. Re-number all local TIDs in this chunk sequentially from TIL_NS.PACK_MIN (0x1000)
  const orderedOldTids = Array.from(neededTids).sort((a, b) => a - b);
  const tidMap = new Map();
  let nextTid = TIL_NS.PACK_MIN;
  for (const oldTid of orderedOldTids) {
    tidMap.set(oldTid, nextTid++);
  }

  const remapTid = (tid) => {
    const t = tid & 0xFFFF;
    return tidMap.has(t) ? tidMap.get(t) : t;
  };
  const remapHex = (hex) => {
    const v = hex >>> 0;
    const base = v & 0xFFFF;
    if (tidMap.has(base)) {
      return ((v & 0xFFFF0000) | tidMap.get(base)) >>> 0;
    }
    return v;
  };

  // 3. Emit rebased types, functions, selectors, enums, and structLayouts
  const rebasedTypes = orderedOldTids.map((oldTid) => {
    const t = allTypesByTid.get(oldTid);
    return {
      ...t,
      tid: tidMap.get(oldTid),
      pointeeTid: remapTid(t.pointeeTid),
    };
  });

  const rebasedFunctions = functions.map((f) => ({
    ...f,
    retHexType: remapHex(f.retHexType),
    paramHexTypes: (f.paramHexTypes || []).map(remapHex),
  }));

  const rebasedSelectors = selectors.map((s) => ({
    ...s,
    retHexType: remapHex(s.retHexType),
    paramHexTypes: (s.paramHexTypes || []).map(remapHex),
  }));

  const rebasedEnums = [];
  const rebasedLayouts = [];
  for (const oldTid of orderedOldTids) {
    const e = allEnumsByTid.get(oldTid);
    if (e) {
      rebasedEnums.push({ ...e, tid: tidMap.get(oldTid) });
    }
    const l = allLayoutsByTid.get(oldTid);
    if (l) {
      rebasedLayouts.push({
        ...l,
        tid: tidMap.get(oldTid),
        members: (l.members || []).map((m) => ({
          ...m,
          hexType: remapHex(m.hexType),
        })),
      });
    }
  }

  return {
    id,
    types: rebasedTypes,
    functions: rebasedFunctions,
    selectors: rebasedSelectors,
    enums: rebasedEnums,
    structLayouts: rebasedLayouts,
  };
}

/**
 * Batch-compiles mixed SDK sources (C headers, .tbd, .swiftinterface, OSS JSON/GDT)
 * into one or more verified (and optionally gzip-compressed) TIL1 binary packs.
 */
export async function compileSdkBatch(inputs, {
  packId = 'local-sdk',
  version = '1.0.0',
  compress = true,
  fflate = null,
  abiAdapter = null,
  maxTypesPerPack = BATCH_SECURITY_LIMITS.MAX_TYPES_PER_PACK,
  maxEntriesPerPack = BATCH_SECURITY_LIMITS.MAX_ENTRIES_PER_PACK,
  matchRules = null,
} = {}) {
  const fileList = Array.isArray(inputs) ? inputs : [];
  if (fileList.length > BATCH_SECURITY_LIMITS.MAX_FILES) {
    throw new Error(`Too many input files (${fileList.length} > ${BATCH_SECURITY_LIMITS.MAX_FILES})`);
  }

  let totalChars = 0;
  const validatedFiles = [];
  const byBasename = new Map();
  const byPath = new Map();

  for (const f of fileList) {
    const check = validateSdkFilePath(f.path);
    if (!check.ok) {
      throw new Error(`Invalid SDK file path: ${check.error}`);
    }
    const content = typeof f.content === 'string'
      ? f.content
      : new TextDecoder('utf-8').decode(f.content);
    if (content.length > BATCH_SECURITY_LIMITS.MAX_SINGLE_FILE_BYTES) {
      throw new Error(`File '${check.normalized}' exceeds max single file size`);
    }
    totalChars += content.length;
    if (totalChars > BATCH_SECURITY_LIMITS.MAX_TOTAL_BYTES) {
      throw new Error('Total SDK input size exceeds limit');
    }
    const entry = { path: check.normalized, content, kind: detectFileKind(check.normalized) };
    validatedFiles.push(entry);
    byPath.set(entry.path, entry);
    const base = entry.path.split('/').pop();
    if (!byBasename.has(base)) byBasename.set(base, entry.path);
  }

  const parsedUnits = new Map();
  const depsByPath = new Map();

  for (const f of validatedFiles) {
    if (f.kind === 'c-header') {
      const parsed = parseLocalTypesHeader(f.content, { abiAdapter });
      const deps = [];
      for (const inc of parsed.includes) {
        const incCheck = validateSdkFilePath(inc.path);
        if (!incCheck.ok) {
          throw new Error(`Unsafe #include '${inc.path}' in '${f.path}': ${incCheck.error}`);
        }
        if (byPath.has(incCheck.normalized)) deps.push(incCheck.normalized);
        else if (byBasename.has(incCheck.normalized.split('/').pop())) {
          deps.push(byBasename.get(incCheck.normalized.split('/').pop()));
        }
      }
      depsByPath.set(f.path, deps);
      parsedUnits.set(f.path, { kind: 'c-header', parsed, path: f.path });
    } else if (f.kind === 'tbd') {
      const parsed = parseTbd(f.content);
      depsByPath.set(f.path, []);
      parsedUnits.set(f.path, { kind: 'tbd', parsed, path: f.path });
    } else if (f.kind === 'swiftinterface') {
      const parsed = parseSwiftInterface(f.content);
      depsByPath.set(f.path, []);
      parsedUnits.set(f.path, { kind: 'swiftinterface', parsed, path: f.path });
    } else if (f.kind === 'gdt-json') {
      depsByPath.set(f.path, []);
      parsedUnits.set(f.path, { kind: 'gdt-json', raw: f.content, path: f.path });
    }
  }

  const allPaths = Array.from(parsedUnits.keys()).sort();
  const { ordered, cycles } = topologicalOrderWithScc(allPaths, (p) => depsByPath.get(p) || []);

  const cHeaderSources = [];
  const otherUnits = [];
  const tbdMetadata = [];

  for (const p of ordered) {
    const u = parsedUnits.get(p);
    if (u.kind === 'c-header') {
      cHeaderSources.push(`/* ${p} */\n${byPath.get(p).content}`);
    } else if (u.kind === 'tbd') {
      otherUnits.push(tbdToSdkIrUnit(u.parsed));
      tbdMetadata.push({
        installName: u.parsed.installName,
        currentVersion: u.parsed.currentVersion,
        targets: u.parsed.targets,
        objcClasses: u.parsed.objcClasses,
      });
    } else if (u.kind === 'swiftinterface') {
      otherUnits.push(swiftInterfaceToSdkIrUnit(u.parsed));
    } else if (u.kind === 'gdt-json') {
      otherUnits.push(gdtJsonToSdkIrUnit(u.raw, { moduleName: p.replace(/\.json$/i, '') }));
    }
  }

  const mergedTypes = [];
  const mergedFunctions = new Map();
  const mergedSelectors = new Map();
  const mergedEnums = [];
  const mergedLayouts = [];
  let nextLocalTid = TIL_NS.PACK_MIN;

  function mergeUnit(irUnit) {
    const tidMap = new Map();
    for (const t of (irUnit.types || [])) {
      const newTid = nextLocalTid++;
      tidMap.set(t.tid, newTid);
      mergedTypes.push({ ...t, tid: newTid });
    }
    const remapHex = (hex) => {
      const base = hex & 0xFFFF;
      if (tidMap.has(base)) return ((hex & 0xFFFF0000) | tidMap.get(base)) >>> 0;
      return hex >>> 0;
    };
    for (const f of (irUnit.functions || [])) {
      const existing = mergedFunctions.get(f.name);
      if (existing && existing.paramHexTypes.length > 0 && f.paramHexTypes.length === 0) {
        continue;
      }
      mergedFunctions.set(f.name, {
        ...f,
        retHexType: remapHex(f.retHexType),
        paramHexTypes: (f.paramHexTypes || []).map(remapHex),
      });
    }
    for (const s of (irUnit.selectors || [])) {
      mergedSelectors.set(s.name, {
        ...s,
        retHexType: remapHex(s.retHexType),
        paramHexTypes: (s.paramHexTypes || []).map(remapHex),
      });
    }
    for (const e of (irUnit.enums || [])) {
      mergedEnums.push({ ...e, tid: tidMap.get(e.tid) ?? e.tid });
    }
    for (const l of (irUnit.structLayouts || [])) {
      mergedLayouts.push({
        ...l,
        tid: tidMap.get(l.tid) ?? l.tid,
        members: (l.members || []).map((m) => ({ ...m, hexType: remapHex(m.hexType) })),
      });
    }
  }

  if (cHeaderSources.length > 0) {
    const combinedParsed = parseLocalTypesHeader(cHeaderSources.join('\n\n'), { abiAdapter });
    const cIr = compileParsedHeaderToIr(combinedParsed, {
      packId,
      baseTid: TIL_NS.PACK_MIN,
      localTidRelative: true,
    });
    mergeUnit(cIr);
  }
  for (const unit of otherUnits) {
    mergeUnit(unit);
  }

  // Split into chunks with full transitive dependency closure & 0x1000 TID rebasing
  const allFuncs = Array.from(mergedFunctions.values());
  const allSels = Array.from(mergedSelectors.values());
  const allTypesByTid = new Map(mergedTypes.map((t) => [t.tid, t]));
  const allEnumsByTid = new Map(mergedEnums.map((e) => [e.tid, e]));
  const allLayoutsByTid = new Map(mergedLayouts.map((l) => [l.tid, l]));

  const chunks = [];
  if (mergedTypes.length <= maxTypesPerPack && allFuncs.length <= maxEntriesPerPack) {
    chunks.push(
      buildRebasedChunk({
        id: packId,
        seedTypes: mergedTypes,
        functions: allFuncs,
        selectors: allSels,
        allTypesByTid,
        allEnumsByTid,
        allLayoutsByTid,
      })
    );
  } else {
    const numChunks = Math.max(
      Math.ceil(mergedTypes.length / maxTypesPerPack),
      Math.ceil(allFuncs.length / maxEntriesPerPack),
      1
    );
    const funcsPerChunk = Math.max(1, Math.ceil(allFuncs.length / numChunks));
    const typesPerChunk = Math.max(1, Math.ceil(mergedTypes.length / numChunks));
    for (let c = 0; c < numChunks; c++) {
      const tSlice = mergedTypes.slice(c * typesPerChunk, (c + 1) * typesPerChunk);
      const fSlice = allFuncs.slice(c * funcsPerChunk, (c + 1) * funcsPerChunk);
      const sSlice = c === 0 ? allSels : [];
      chunks.push(
        buildRebasedChunk({
          id: `${packId}-part${c + 1}`,
          seedTypes: tSlice,
          functions: fSlice,
          selectors: sSlice,
          allTypesByTid,
          allEnumsByTid,
          allLayoutsByTid,
        })
      );
    }
  }

  const ff = compress ? await getFflate(fflate) : null;
  const packs = [];

  for (const chunk of chunks) {
    const tilBytes = compileTil1({
      packId: chunk.id,
      isCore: false,
      localTidRelative: true,
      types: chunk.types,
      functions: chunk.functions,
      selectors: chunk.selectors,
      enums: chunk.enums,
      structLayouts: chunk.structLayouts,
    });
    const validation = validateTil1Buffer(tilBytes);
    if (!validation.ok) {
      throw new Error(`Batch compiler produced invalid TIL1 for '${chunk.id}': ${validation.error}`);
    }
    const gzBytes = ff ? ff.gzipSync(tilBytes, { level: 6, mtime: 0 }) : null;
    const rawSha256 = sha256HexSync(tilBytes);
    const gzSha256 = gzBytes ? sha256HexSync(gzBytes) : null;

    packs.push({
      packId: chunk.id,
      version,
      tilBytes,
      gzBytes,
      rawBytes: tilBytes.byteLength,
      gzBytesLen: gzBytes ? gzBytes.byteLength : 0,
      sha256: rawSha256,
      gzSha256,
      checksumFnv32: validation.header.checksumFnv32,
      entryCount: validation.header.entryCount,
      selCount: validation.header.selCount,
      typeCount: validation.header.typeCount,
      meta: {
        packId: chunk.id,
        version,
        source: 'local-compiled',
        tbdLibraries: tbdMetadata,
        matchRules: matchRules || undefined,
      },
    });
  }

  return {
    packId,
    version,
    fileCount: validatedFiles.length,
    cyclesDetected: cycles,
    packs,
  };
}

function detectFileKind(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tbd')) return 'tbd';
  if (lower.endsWith('.swiftinterface')) return 'swiftinterface';
  if (lower.endsWith('.json')) return 'gdt-json';
  return 'c-header';
}
