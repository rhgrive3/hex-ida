/**
 * Swift .swiftinterface Declaration Parser.
 * Spec: hex_ida_beyond_ida_design.md §18.3
 * Extracts public Swift structs, classes, actors, enums, protocols, typealiases,
 * functions/inits (skipping function bodies), @_cdecl, @objc selectors, and swiftcall ABI.
 * INV-005: ZERO imports from js/targets/architecture/.
 */

import {
  TIL_PRIM,
  HEX_KIND,
  SIG_FLAG,
  CALL_CONV,
  makeHexTypeId,
  hexPtr,
} from './til-lite-data.js';

const SWIFT_TYPE_MAP = new Map([
  ['Void', makeHexTypeId({ baseTilId: TIL_PRIM.VOID })],
  ['()', makeHexTypeId({ baseTilId: TIL_PRIM.VOID })],
  ['Bool', makeHexTypeId({ baseTilId: TIL_PRIM.BOOL })],
  ['Int8', makeHexTypeId({ baseTilId: TIL_PRIM.I8 })],
  ['UInt8', makeHexTypeId({ baseTilId: TIL_PRIM.U8 })],
  ['Int16', makeHexTypeId({ baseTilId: TIL_PRIM.I16 })],
  ['UInt16', makeHexTypeId({ baseTilId: TIL_PRIM.U16 })],
  ['Int32', makeHexTypeId({ baseTilId: TIL_PRIM.I32 })],
  ['UInt32', makeHexTypeId({ baseTilId: TIL_PRIM.U32 })],
  ['Int64', makeHexTypeId({ baseTilId: TIL_PRIM.I64 })],
  ['UInt64', makeHexTypeId({ baseTilId: TIL_PRIM.U64 })],
  ['Int', makeHexTypeId({ baseTilId: TIL_PRIM.I64 })],
  ['UInt', makeHexTypeId({ baseTilId: TIL_PRIM.U64 })],
  ['Float', makeHexTypeId({ baseTilId: TIL_PRIM.F32 })],
  ['Float32', makeHexTypeId({ baseTilId: TIL_PRIM.F32 })],
  ['Double', makeHexTypeId({ baseTilId: TIL_PRIM.F64 })],
  ['Float64', makeHexTypeId({ baseTilId: TIL_PRIM.F64 })],
  ['CGFloat', makeHexTypeId({ baseTilId: TIL_PRIM.F64 })],
  ['UnsafeRawPointer', hexPtr(TIL_PRIM.VOID, { isConst: true })],
  ['UnsafeMutableRawPointer', hexPtr(TIL_PRIM.VOID)],
  ['OpaquePointer', hexPtr(TIL_PRIM.VOID)],
  ['AnyObject', makeHexTypeId({ baseTilId: TIL_PRIM.OBJC_ID, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ })],
  ['Selector', makeHexTypeId({ baseTilId: TIL_PRIM.OBJC_SEL })],
]);

function mapSwiftTypeToHex(typeStr, typeNameToTid) {
  const clean = String(typeStr || '').trim()
    .replace(/^(?:inout|__owned|__shared|borrowing|consuming|@escaping|@Sendable|@MainActor)\s+/g, '')
    .replace(/\?$/, '')
    .replace(/!$/, '')
    .trim();
  if (!clean) return makeHexTypeId({ baseTilId: TIL_PRIM.VOID });
  if (SWIFT_TYPE_MAP.has(clean)) return SWIFT_TYPE_MAP.get(clean);
  if (clean.startsWith('UnsafePointer<')) {
    return hexPtr(TIL_PRIM.VOID, { isConst: true });
  }
  if (clean.startsWith('UnsafeMutablePointer<')) {
    return hexPtr(TIL_PRIM.VOID);
  }
  const baseName = clean.split('<')[0].split('.').pop();
  if (typeNameToTid && typeNameToTid.has(baseName)) {
    return makeHexTypeId({ baseTilId: typeNameToTid.get(baseName), kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
  }
  return makeHexTypeId({ baseTilId: TIL_PRIM.OBJC_ID, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
}

function splitTopLevelParams(paramListStr) {
  const parts = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < paramListStr.length; i++) {
    const ch = paramListStr[i];
    if (ch === '(' || ch === '<' || ch === '[') depth++;
    else if (ch === ')' || ch === '>' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function parseSwiftParams(paramListStr) {
  const rawParams = splitTopLevelParams(paramListStr);
  const params = [];
  for (const p of rawParams) {
    const colonIdx = p.indexOf(':');
    if (colonIdx === -1) continue;
    const lhs = p.slice(0, colonIdx).trim().split(/\s+/);
    const label = lhs[0] || '_';
    const localName = lhs.length > 1 ? lhs[1] : label;
    const typeStr = p.slice(colonIdx + 1).split('=')[0].trim();
    params.push({ label, name: localName, type: typeStr });
  }
  return params;
}

function findMatchingBrace(text, openIdx) {
  let depth = 0;
  let inStr = false;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

/**
 * Parses a Swift .swiftinterface source file.
 */
export function parseSwiftInterface(source, { moduleName: overrideModule = '' } = {}) {
  const text = String(source || '').replace(/\r\n?/g, '\n');

  // Extract header metadata comments
  let moduleName = overrideModule;
  let targetTriple = '';
  let compilerVersion = '';
  const imports = [];

  for (const line of text.split('\n').slice(0, 40)) {
    const modM = /-module-name\s+([A-Za-z0-9_]+)/.exec(line);
    if (modM && !moduleName) moduleName = modM[1];
    const tgtM = /-target\s+([^\s]+)/.exec(line);
    if (tgtM) targetTriple = tgtM[1];
    const verM = /\/\/\s*swift-compiler-version:\s*(.+)/.exec(line);
    if (verM) compilerVersion = verM[1].trim();
  }

  // Strip comments while keeping newlines
  const noComments = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, '');

  const types = []; // { kind, name, moduleName, conformances, fields, methods }
  const functions = []; // top-level + member funcs
  const typealiases = [];

  // Extract imports
  for (const m of noComments.matchAll(/^\s*(?:@_exported\s+)?import\s+([A-Za-z0-9_.]+)/gm)) {
    imports.push(m[1]);
  }

  // Recursive block scanner: scans top-level or inside a type body
  function scanBlock(blockText, enclosingType = null) {
    let i = 0;
    const len = blockText.length;

    while (i < len) {
      // Skip whitespace & semicolons
      while (i < len && /[\s;]/.test(blockText[i])) i++;
      if (i >= len) break;

      // Collect leading @attributes (e.g. @_cdecl("foo"), @objc(bar:), @inlinable, @available(...))
      const attrs = [];
      while (i < len && blockText[i] === '@') {
        const start = i;
        i++;
        while (i < len && /[A-Za-z0-9_.]/.test(blockText[i])) i++;
        if (blockText[i] === '(') {
          let pd = 1;
          i++;
          while (i < len && pd > 0) {
            if (blockText[i] === '(') pd++;
            else if (blockText[i] === ')') pd--;
            i++;
          }
        }
        attrs.push(blockText.slice(start, i));
        while (i < len && /\s/.test(blockText[i])) i++;
      }

      // Read declaration header up to '{' or '\n'
      const lineStart = i;
      let parenDepth = 0;
      let angleDepth = 0;
      while (i < len) {
        const ch = blockText[i];
        if (ch === '(') parenDepth++;
        else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
        else if (ch === '<') angleDepth++;
        else if (ch === '>') angleDepth = Math.max(0, angleDepth - 1);
        else if (parenDepth === 0 && angleDepth === 0 && (ch === '{' || ch === '\n')) {
          break;
        }
        i++;
      }

      const header = blockText.slice(lineStart, i).trim();
      const hasBody = blockText[i] === '{';
      let bodyText = '';
      if (hasBody) {
        const closeIdx = findMatchingBrace(blockText, i);
        bodyText = blockText.slice(i + 1, closeIdx);
        i = closeIdx + 1;
      } else {
        i++;
      }

      if (!header || header.startsWith('import ')) continue;

      // Check attributes
      let cdeclName = null;
      let objcSelector = null;
      let hasObjc = false;
      for (const a of attrs) {
        const cm = /^@_cdecl\(\s*"([^"]+)"\s*\)$/.exec(a);
        if (cm) cdeclName = cm[1];
        const om = /^@objc(?:\(\s*([^)]+)\s*\))?$/.exec(a);
        if (om) {
          hasObjc = true;
          if (om[1]) objcSelector = om[1].trim();
        }
      }

      // Type declaration: public/open struct | class | actor | enum | protocol | extension
      const typeM = /^(?:(?:public|open|internal|private|final|indirect|nonisolated)\s+)*(struct|class|actor|enum|protocol|extension)\s+([A-Za-z0-9_.]+)(?:<[^>]*>)?(?:\s*:\s*([^{]+))?/.exec(header);
      if (typeM) {
        const [, kind, name, inheritRaw] = typeM;
        const conformances = inheritRaw
          ? inheritRaw.split(',').map((s) => s.trim()).filter(Boolean)
          : [];
        let typeObj = types.find((t) => t.name === name);
        if (!typeObj) {
          typeObj = {
            kind: kind === 'extension' ? 'struct' : kind,
            name,
            moduleName: moduleName || 'Swift',
            conformances,
            fields: [],
            methods: [],
            isObjc: hasObjc,
          };
          types.push(typeObj);
        }
        if (hasBody) {
          scanBlock(bodyText, typeObj);
        }
        continue;
      }

      // typealias
      const taM = /^(?:(?:public|open)\s+)*typealias\s+([A-Za-z0-9_]+)(?:<[^>]*>)?\s*=\s*(.+)$/.exec(header);
      if (taM) {
        typealiases.push({ name: taM[1], target: taM[2].trim(), enclosingType: enclosingType?.name || null });
        continue;
      }

      // Stored/computed property inside a type: public var/let name: Type
      if (enclosingType) {
        const propM = /^(?:(?:public|open|static|class|final|lazy|weak|unowned|override)\s+)*(var|let)\s+([A-Za-z0-9_]+)\s*:\s*([^={]+)/.exec(header);
        if (propM) {
          enclosingType.fields.push({
            name: propM[2],
            type: propM[3].trim(),
            isConst: propM[1] === 'let',
            isStatic: /\b(?:static|class)\b/.test(header),
          });
          continue;
        }
      }

      // Function or init declaration (skip body)
      const funcM = /^(?:(?:public|open|static|class|final|override|mutating|nonmutating|convenience|required|nonisolated)\s+)*(func\s+([A-Za-z0-9_`]+)|init\??)(?:<[^>]*>)?\s*\(([\s\S]*?)\)\s*(?:async\s+)?(?:throws\s+)?(?:->\s*(.+))?$/.exec(header);
      if (funcM) {
        const isInit = funcM[1].startsWith('init');
        const rawFnName = isInit ? 'init' : funcM[2].replace(/`/g, '');
        const isStatic = /\b(?:static|class)\b/.test(header);
        const params = parseSwiftParams(funcM[3] || '');
        const returnType = isInit
          ? (enclosingType ? enclosingType.name : 'Void')
          : (funcM[4] ? funcM[4].replace(/\s+where\s+.*$/, '').trim() : 'Void');
        const labels = params.map((p) => `${p.label}:`).join('');
        const qualifiedKey = enclosingType
          ? `${moduleName || 'Swift'}.${enclosingType.name}.${rawFnName}(${labels})`
          : `${moduleName || 'Swift'}.${rawFnName}(${labels})`;

        const fnRecord = {
          name: rawFnName,
          qualifiedKey,
          enclosingType: enclosingType ? enclosingType.name : null,
          isStatic,
          isInit,
          params,
          returnType,
          cdeclName,
          hasObjc,
          objcSelector: objcSelector || (hasObjc ? `${rawFnName}${labels ? ':' : ''}` : null),
          callConv: cdeclName ? CALL_CONV.AAPCS64 : CALL_CONV.SWIFTCALL,
        };
        functions.push(fnRecord);
        if (enclosingType) enclosingType.methods.push(fnRecord);
      }
    }
  }

  scanBlock(noComments, null);

  return {
    moduleName: moduleName || 'SwiftModule',
    targetTriple,
    compilerVersion,
    imports: Array.from(new Set(imports)),
    types,
    typealiases,
    functions,
  };
}

/**
 * Converts parsed .swiftinterface output into a unified SdkIrUnit for TIL1 compilation.
 */
export function swiftInterfaceToSdkIrUnit(parsed, { baseTid = 0x1000 } = {}) {
  let nextTid = baseTid;
  const typeNameToTid = new Map();
  const types = [];
  const functions = [];
  const selectors = [];

  for (const t of parsed.types) {
    const tid = nextTid++;
    typeNameToTid.set(t.name, tid);
    types.push({
      tid,
      name: `${parsed.moduleName}.${t.name}`,
      kind: t.kind === 'struct' ? HEX_KIND.STRUCT : HEX_KIND.OBJC_OR_SWIFT_OBJ,
      bits: 64,
      qualifiers: 0,
      pointeeTid: 0,
    });
  }

  for (const f of parsed.functions) {
    const retHex = mapSwiftTypeToHex(f.returnType, typeNameToTid);
    const paramHexTypes = f.params.map((p) => mapSwiftTypeToHex(p.type, typeNameToTid));

    // Normalized Swift key with swiftcall convention (§18.3)
    functions.push({
      name: f.qualifiedKey,
      retHexType: retHex,
      paramHexTypes,
      flags: 0,
      fmtArgIdx: 0xFF,
      callConv: CALL_CONV.SWIFTCALL,
    });

    // @_cdecl exported C symbol
    if (f.cdeclName) {
      functions.push({
        name: f.cdeclName,
        retHexType: retHex,
        paramHexTypes,
        flags: 0,
        fmtArgIdx: 0xFF,
        callConv: CALL_CONV.AAPCS64,
      });
    }

    // @objc selector entry
    if (f.hasObjc && f.objcSelector) {
      const cls = f.enclosingType || '*';
      const sign = f.isStatic ? '+' : '-';
      const selfHex = makeHexTypeId({ baseTilId: TIL_PRIM.OBJC_ID, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
      const selHex = makeHexTypeId({ baseTilId: TIL_PRIM.OBJC_SEL });
      selectors.push({
        name: `${sign}${cls}:${f.objcSelector}`,
        retHexType: retHex,
        paramHexTypes: [selfHex, selHex, ...paramHexTypes],
        flags: f.isStatic ? SIG_FLAG.OBJC_CLASS_METHOD : 0,
        fmtArgIdx: 0xFF,
        callConv: CALL_CONV.AAPCS64,
      });
    }
  }

  return {
    kind: 'swiftinterface',
    moduleName: parsed.moduleName,
    targetTriple: parsed.targetTriple,
    imports: parsed.imports,
    types,
    functions,
    selectors,
    enums: [],
    structLayouts: [],
  };
}
