/**
 * Apple Text-Based Stub (.tbd v1–v4 YAML-subset & v5 JSON) Parser.
 * Spec: hex_ida_beyond_ida_design.md §18.3
 * Extracts: tbdVersion, installName, currentVersion, compatibilityVersion,
 * targets/archs, exported symbols, ObjC classes/ivars/eh-types, weak-defs, re-exports.
 * INV-005: ZERO imports from js/targets/architecture/.
 */

import { TIL_PRIM, HEX_KIND, CALL_CONV, makeHexTypeId } from './til-lite-data.js';

function unquote(s) {
  const t = String(s || '').trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseInlineArray(str) {
  const inner = str.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!inner) return [];
  const items = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === ',') {
      const v = unquote(cur);
      if (v) items.push(v);
      cur = '';
      continue;
    }
    cur += ch;
  }
  const last = unquote(cur);
  if (last) items.push(last);
  return items;
}

function parseTbdV5Json(text) {
  const doc = JSON.parse(text);
  const main = doc.main_library || doc;
  const targets = (main.target_info || []).map((t) => t.target).filter(Boolean);
  const archs = Array.from(new Set(targets.map((t) => t.split('-')[0]).filter(Boolean)));
  const installName = main.install_names?.[0]?.name || main.install_name || '';
  const currentVersion = main.current_versions?.[0]?.version || main.current_version || '1.0.0';
  const compatibilityVersion = main.compatibility_versions?.[0]?.version || main.compatibility_version || '1.0.0';

  const exportSlices = [];
  const rawExports = main.exported_symbols || [];
  for (const exp of rawExports) {
    const data = exp.data || exp;
    const textSec = exp.text || {};
    exportSlices.push({
      targets: exp.targets || targets,
      archs: (exp.targets || targets).map((t) => t.split('-')[0]),
      symbols: [...(textSec.global || []), ...(data.global || [])],
      objcClasses: data.objc_class || [],
      objcIvars: data.objc_ivar || [],
      objcEhTypes: data.objc_eh_type || [],
      weakDefSymbols: [...(textSec.weak || []), ...(data.weak || [])],
      threadLocalSymbols: textSec.thread_local || [],
    });
  }

  const reExports = [];
  for (const re of (main.reexported_libraries || [])) {
    for (const lib of (re.names || [])) reExports.push(lib);
  }

  return finalizeTbdResult({
    tbdVersion: 5,
    installName,
    currentVersion,
    compatibilityVersion,
    parentUmbrella: '',
    swiftAbiVersion: main.swift_abi?.[0]?.abi ?? null,
    flags: [],
    targets,
    archs,
    reExports,
    exportSlices,
  });
}

/**
 * Parses an Apple .tbd file (v1–v4 YAML subset or v5 JSON).
 * Multi-document YAML streams (--- !tapi-tbd ... --- !tapi-tbd ...) return the primary document
 * plus any embedded re-exported documents in `documents[]`.
 */
export function parseTbd(source) {
  const text = String(source || '').trim();
  if (!text) {
    return finalizeTbdResult({ tbdVersion: 0, installName: '', exportSlices: [] });
  }
  if (text.startsWith('{')) {
    return parseTbdV5Json(text);
  }

  // Split multi-document YAML on `---`
  const rawDocs = text
    .split(/^---\s*(?:!tapi-tbd[^\n]*)?$/m)
    .map((d) => d.replace(/^\.\.\.\s*$/m, '').trim())
    .filter(Boolean);

  const parsedDocs = rawDocs.map(parseSingleYamlTbd);
  const primary = parsedDocs[0] || finalizeTbdResult({ tbdVersion: 0, installName: '', exportSlices: [] });
  if (parsedDocs.length > 1) {
    primary.documents = parsedDocs;
  }
  return primary;
}

function parseSingleYamlTbd(docText) {
  const lines = docText.replace(/\r\n?/g, '\n').split('\n');
  let tbdVersion = 3;
  let installName = '';
  let currentVersion = '1.0.0';
  let compatibilityVersion = '1.0.0';
  let parentUmbrella = '';
  let swiftAbiVersion = null;
  let flags = [];
  let targets = [];
  let archs = [];
  const reExports = [];
  const exportSlices = [];

  let section = null; // 'exports' | 'reexports' | 'undefineds' | null
  let currentSlice = null;
  let activeArrayKey = null;
  let activeArrayBuf = '';

  function flushArrayBuf() {
    if (!activeArrayKey) return;
    const items = parseInlineArray(activeArrayBuf);
    assignKeyValue(activeArrayKey, items);
    activeArrayKey = null;
    activeArrayBuf = '';
  }

  function assignKeyValue(key, items) {
    if (section === 'exports' && currentSlice) {
      if (key === 'archs') currentSlice.archs.push(...items);
      else if (key === 'targets') {
        currentSlice.targets.push(...items);
        for (const t of items) {
          const a = t.split('-')[0];
          if (a && !currentSlice.archs.includes(a)) currentSlice.archs.push(a);
        }
      }
      else if (key === 'symbols') currentSlice.symbols.push(...items);
      else if (key === 'objc-classes') currentSlice.objcClasses.push(...items);
      else if (key === 'objc-ivars') currentSlice.objcIvars.push(...items);
      else if (key === 'objc-eh-types') currentSlice.objcEhTypes.push(...items);
      else if (key === 'weak-def-symbols' || key === 'weak-symbols') currentSlice.weakDefSymbols.push(...items);
      else if (key === 'thread-local-symbols') currentSlice.threadLocalSymbols.push(...items);
      else if (key === 're-exports') reExports.push(...items);
    } else if (section === 'reexports') {
      if (key === 'libraries' || key === 're-exports') reExports.push(...items);
    } else {
      if (key === 'archs') archs.push(...items);
      else if (key === 'targets') {
        targets.push(...items);
        for (const t of items) {
          const a = t.split('-')[0];
          if (a && !archs.includes(a)) archs.push(a);
        }
      }
      else if (key === 'flags') flags.push(...items);
      else if (key === 're-exports') reExports.push(...items);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const stripped = rawLine.replace(/#.*$/, '').trimEnd();
    const trim = stripped.trim();
    if (!trim || trim === '...') continue;

    // Continuation of a multi-line `[ ... ]` YAML array
    if (activeArrayKey) {
      activeArrayBuf += ' ' + trim;
      if (trim.includes(']')) {
        flushArrayBuf();
      }
      continue;
    }

    const indent = stripped.length - stripped.trimStart().length;

    // Top-level key
    if (indent === 0) {
      const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(trim);
      if (!m) continue;
      const [, key, val] = m;
      if (key === 'exports' || key === 'reexported-libraries' || key === 'undefineds') {
        section = key === 'reexported-libraries' ? 'reexports' : key;
        currentSlice = null;
        continue;
      }
      section = null;
      currentSlice = null;
      if (key === 'tbd-version') tbdVersion = parseInt(unquote(val), 10) || 4;
      else if (key === 'install-name') installName = unquote(val);
      else if (key === 'current-version') currentVersion = unquote(val);
      else if (key === 'compatibility-version') compatibilityVersion = unquote(val);
      else if (key === 'parent-umbrella') parentUmbrella = unquote(val);
      else if (key === 'swift-abi-version' || key === 'swift-version') swiftAbiVersion = parseInt(unquote(val), 10) || null;
      else if (val.startsWith('[')) {
        if (val.includes(']')) {
          assignKeyValue(key, parseInlineArray(val));
        } else {
          activeArrayKey = key;
          activeArrayBuf = val;
        }
      }
      continue;
    }

    // Inside exports / reexports list
    if (section === 'exports' || section === 'reexports') {
      const isNewItem = trim.startsWith('- ');
      const itemBody = isNewItem ? trim.slice(2).trim() : trim;

      if (isNewItem && section === 'exports') {
        currentSlice = {
          targets: [],
          archs: [],
          symbols: [],
          objcClasses: [],
          objcIvars: [],
          objcEhTypes: [],
          weakDefSymbols: [],
          threadLocalSymbols: [],
        };
        exportSlices.push(currentSlice);
      }

      const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(itemBody);
      if (m) {
        const [, key, val] = m;
        if (val.startsWith('[')) {
          if (val.includes(']')) {
            assignKeyValue(key, parseInlineArray(val));
          } else {
            activeArrayKey = key;
            activeArrayBuf = val;
          }
        } else if (val) {
          assignKeyValue(key, [unquote(val)]);
        }
      }
    }
  }
  flushArrayBuf();

  return finalizeTbdResult({
    tbdVersion,
    installName,
    currentVersion,
    compatibilityVersion,
    parentUmbrella,
    swiftAbiVersion,
    flags,
    targets,
    archs,
    reExports,
    exportSlices,
  });
}

function finalizeTbdResult(raw) {
  const symbolSet = new Set();
  const objcClassSet = new Set();
  const objcIvarSet = new Set();
  const objcEhTypeSet = new Set();
  const weakDefSet = new Set();
  const archSet = new Set(raw.archs || []);
  const targetSet = new Set(raw.targets || []);

  for (const slice of (raw.exportSlices || [])) {
    for (const a of (slice.archs || [])) archSet.add(a);
    for (const t of (slice.targets || [])) targetSet.add(t);
    for (const s of (slice.symbols || [])) symbolSet.add(s);
    for (const c of (slice.objcClasses || [])) objcClassSet.add(c);
    for (const iv of (slice.objcIvars || [])) objcIvarSet.add(iv);
    for (const eh of (slice.objcEhTypes || [])) objcEhTypeSet.add(eh);
    for (const w of (slice.weakDefSymbols || [])) weakDefSet.add(w);
  }

  return {
    tbdVersion: raw.tbdVersion || 4,
    installName: raw.installName || '',
    currentVersion: raw.currentVersion || '1.0.0',
    compatibilityVersion: raw.compatibilityVersion || '1.0.0',
    parentUmbrella: raw.parentUmbrella || '',
    swiftAbiVersion: raw.swiftAbiVersion ?? null,
    flags: raw.flags || [],
    targets: Array.from(targetSet),
    archs: Array.from(archSet),
    reExports: Array.from(new Set(raw.reExports || [])),
    exportSlices: raw.exportSlices || [],
    symbols: Array.from(symbolSet),
    objcClasses: Array.from(objcClassSet),
    objcIvars: Array.from(objcIvarSet),
    objcEhTypes: Array.from(objcEhTypeSet),
    weakDefSymbols: Array.from(weakDefSet),
  };
}

/**
 * Converts a parsed .tbd result into a unified SdkIrUnit for sdk-batch-compiler.
 */
export function tbdToSdkIrUnit(parsedTbd, { baseTid = 0x1000 } = {}) {
  let nextTid = baseTid;
  const types = [];
  const functions = [];

  for (const cls of parsedTbd.objcClasses) {
    types.push({
      tid: nextTid++,
      name: cls,
      kind: HEX_KIND.OBJC_OR_SWIFT_OBJ,
      bits: 64,
      qualifiers: 0,
      pointeeTid: 0,
    });
  }

  const voidHex = makeHexTypeId({ baseTilId: TIL_PRIM.VOID });
  for (const sym of parsedTbd.symbols) {
    // Strip leading underscore for C ABI lookup consistency
    const clean = sym.startsWith('_') && !sym.startsWith('__Z') && !sym.startsWith('_$s')
      ? sym.slice(1)
      : sym;
    functions.push({
      name: clean,
      retHexType: voidHex,
      paramHexTypes: [],
      flags: 0,
      fmtArgIdx: 0xFF,
      callConv: CALL_CONV.AAPCS64,
    });
  }

  return {
    kind: 'tbd',
    moduleName: parsedTbd.installName.split('/').pop()?.replace(/\.(?:dylib|tbd)$/, '') || 'unknown',
    installName: parsedTbd.installName,
    currentVersion: parsedTbd.currentVersion,
    compatibilityVersion: parsedTbd.compatibilityVersion,
    targets: parsedTbd.targets,
    archs: parsedTbd.archs,
    reExports: parsedTbd.reExports,
    objcClasses: parsedTbd.objcClasses,
    objcIvars: parsedTbd.objcIvars,
    types,
    functions,
    selectors: [],
    enums: [],
    structLayouts: [],
  };
}
