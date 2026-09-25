/*
 * Compile-oriented C translation-unit packaging.
 *
 * This is deliberately additive.  Function-scoped decompile() keeps returning
 * the same pseudocode presentation; callers that want a C translation unit opt
 * into this packager.  Evidence-backed declarations keep their evidence kind;
 * names with no usable evidence also get an explicit syntax-only fallback
 * (extern byte-array globals, unspecified-arity callee/pseudo-intrinsic
 * prototypes) so the packaged source parses.  Every fallback keeps its
 * unresolved entry: the unit stays `partial` and the missing evidence stays
 * named in `unresolved`.
 */

const FIXED_WIDTH_ALIASES = Object.freeze(new Map([
  ['int8', 'int8_t'], ['uint8', 'uint8_t'],
  ['int16', 'int16_t'], ['uint16', 'uint16_t'],
  ['int32', 'int32_t'], ['uint32', 'uint32_t'],
  ['int64', 'int64_t'], ['uint64', 'uint64_t'],
]));

const C_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEYWORDS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double',
  'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long',
  'register', 'restrict', 'return', 'short', 'signed', 'sizeof', 'static', 'struct',
  'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while',
  // Language constructs that appear as `name(` in emitted text but are never
  // declarable identifiers; a fallback prototype for them would not parse.
  '_Bool', '_Complex', '_Static_assert', '_Alignof', 'alignof', 'asm', '__asm', '__asm__',
  'true', 'false', 'NULL',
]);
const PSEUDO_INTRINSIC = /^(?:phi|bit_extract|bit_insert|sext|zext|trunc|__arm64_[A-Za-z0-9_]*|__a64_[A-Za-z0-9_]*)$/;
const SIMPLE_C_TYPE = /^(?:(?:const|volatile|restrict)\s+)*(?:void|bool|float|double|u?int(?:8|16|32|64)_t|size_t|ptrdiff_t|uintptr_t|intptr_t|__int128|unsigned\s+__int128|(?:(?:signed|unsigned)\s+)?(?:char|short|int|long|long\s+long))(?:\s*\*)*$/;

function addressKey(value) {
  if (value == null) return null;
  try { return BigInt(value).toString(); } catch { return null; }
}

function addressText(value) {
  const key = addressKey(value);
  return key == null ? null : `0x${BigInt(key).toString(16)}`;
}

function declarationBearingText(text) {
  const source = String(text ?? '');
  let out = '';
  let state = 'code';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') { out += '  '; i++; state = 'line'; continue; }
      if (ch === '/' && next === '*') { out += '  '; i++; state = 'block'; continue; }
      if (ch === '"') { out += ' '; state = 'string'; continue; }
      if (ch === "'") { out += ' '; state = 'char'; continue; }
      out += ch;
      continue;
    }
    if (state === 'line') {
      if (ch === '\n') { out += '\n'; state = 'code'; } else out += ' ';
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { out += '  '; i++; state = 'code'; }
      else out += ch === '\n' ? '\n' : ' ';
      continue;
    }
    if (ch === '\\') { out += '  '; i++; continue; }
    if ((state === 'string' && ch === '"') || (state === 'char' && ch === "'")) {
      out += ' '; state = 'code';
    } else out += ch === '\n' ? '\n' : ' ';
  }
  return out;
}

function normalizedType(raw) {
  if (typeof raw !== 'string') return null;
  let type = raw.trim().replace(/\s+/g, ' ');
  for (const [alias, standard] of FIXED_WIDTH_ALIASES) {
    type = type.replace(new RegExp(`\\b${alias}\\b`, 'g'), standard);
  }
  if (!type || /\b(?:unknown|auto|closure|function)\b/i.test(type)) return null;
  return SIMPLE_C_TYPE.test(type) ? type : null;
}

function headersForText(text, headers) {
  const source = declarationBearingText(text);
  if (/\b(?:u?int(?:8|16|32|64)_t|uintptr_t|intptr_t)\b/.test(source)) headers.add('<stdint.h>');
  if (/\b(?:size_t|ptrdiff_t)\b/.test(source)) headers.add('<stddef.h>');
  if (/\bbool\b/.test(source)) headers.add('<stdbool.h>');
}

function aliasContractsForText(text, headers, declarations) {
  const source = declarationBearingText(text);
  for (const [alias, standard] of FIXED_WIDTH_ALIASES) {
    if (!new RegExp(`\\b${alias}\\b`).test(source)) continue;
    if (new RegExp(`typedef\\s+[^;]*\\b${alias}\\s*;`).test(source)) continue;
    headers.add('<stdint.h>');
    declarations.add(`typedef ${standard} ${alias};`);
  }
}

function functionAddress(fn) {
  return fn?.address ?? fn?.startAddress ?? fn?.startAddr ?? fn?.functionId ?? null;
}

function functionName(fn) {
  if (C_IDENTIFIER.test(String(fn?.name ?? ''))) return String(fn.name);
  const match = /^\s*[^();{}]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(String(fn?.signature ?? fn?.pseudocode ?? ''));
  return match?.[1] ?? null;
}

function signatureDeclaration(signature) {
  const text = String(signature ?? '').trim().replace(/\s*\{\s*$/, '');
  if (!text || !text.includes('(') || !text.endsWith(')')) return null;
  return `${text};`;
}

/*
 * A producer-supplied signature line, not a comment/typedef/prelude line.  The
 * final public text starts with the fixed-width prelude, so the first line of
 * the pseudocode is not the signature when the producer did not carry one.
 */
function looksLikeSignature(text) {
  const value = String(text ?? '').trim();
  if (!value || value === 'true' || value === 'false' || /[;{}]/.test(value)) return false;
  return /^[A-Za-z_][A-Za-z0-9_\s*]*\s+[^\s(]+\s*\([^;{}]*\)\s*$/.test(value);
}

function signatureFromText(text) {
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('/*') || line.startsWith('//') || line.startsWith('#')) continue;
    if (looksLikeSignature(line)) return line;
    // The signature, when present, precedes the function body.
    if (line === '{' || line.endsWith('{')) break;
  }
  return null;
}

function safeSignatureDeclaration(signature) {
  const text = String(signature ?? '').trim().replace(/\s*\{\s*$/, '');
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 1 || close !== text.length - 1) return null;
  const prefix = text.slice(0, open).trim();
  const words = prefix.split(/\s+/);
  const name = words.at(-1);
  const returnType = words.slice(0, -1).join(' ');
  if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !normalizedType(returnType)) return null;
  for (const group of text.slice(open + 1, close).split(',')) {
    const value = group.trim();
    if (!value || /^void$/i.test(value)) continue;
    const parameter = /^(.*?)(?:\s+)([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
    if (!parameter || !normalizedType(parameter[1])) return null;
  }
  return `${prefix}(${text.slice(open + 1, close)});`;
}

function emittedFunctionAlias(fn, index) {
  const text = String(fn?.signature ?? fn?.pseudocode ?? '');
  const match = /^\s*[^();{}]+\s+([^\s(]+)\s*\(/.exec(text);
  const candidate = match?.[1] ?? null;
  return candidate && C_IDENTIFIER.test(candidate) ? candidate : `hex_tu_fn_${index}`;
}

function syntaxOnlyFunctionSource(signature, alias) {
  const declaration = safeSignatureDeclaration(signature);
  return `${declaration ? declaration.slice(0, -1) : `void ${alias}(void)`}\n{\n    __builtin_trap(); /* hex-tu-fallback: body withheld; syntax-only placeholder. */\n}`;
}

function instructionList(fn) {
  if (Array.isArray(fn?.ir?.instructions)) return fn.ir.instructions;
  if (Array.isArray(fn?.semanticIR?.instructions)) return fn.semanticIR.instructions;
  if (Array.isArray(fn?.semanticIR?.nodes)) return fn.semanticIR.nodes;
  return [];
}

function prototypeArguments(prototype) {
  if (!prototype || typeof prototype !== 'object') return null;
  if (Array.isArray(prototype.parameters)) return prototype.parameters;
  if (Array.isArray(prototype.args)) return prototype.args;
  if (Array.isArray(prototype.arguments)) return prototype.arguments;
  return null;
}

function renderPrototype(name, prototype) {
  if (!C_IDENTIFIER.test(String(name ?? '')) || !prototype || typeof prototype !== 'object') return null;
  const args = prototypeArguments(prototype);
  if (args == null) return null;
  const returnType = prototype.returnsValue === false ? 'void' : normalizedType(prototype.returnType ?? prototype.type ?? '');
  if (!returnType) return null;
  const rendered = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? {};
    const type = normalizedType(typeof arg === 'string' ? arg : arg.type ?? arg.cType ?? '');
    if (!type) return null;
    const nameCandidate = typeof arg === 'object' ? arg.name : null;
    const argName = C_IDENTIFIER.test(String(nameCandidate ?? '')) ? String(nameCandidate) : `a${i + 1}`;
    rendered.push(`${type} ${argName}`);
  }
  if (prototype.variadic === true) {
    if (!rendered.length) return null;
    rendered.push('...');
  }
  return `${returnType} ${name}(${rendered.length ? rendered.join(', ') : 'void'});`;
}

function callRecord(inst, symbolFor) {
  if (String(inst?.op ?? inst?.kind ?? '').toLowerCase() !== 'call') return null;
  const target = inst?.extra?.target ?? inst?.target ?? inst?.callTarget ?? inst?.call?.target ?? null;
  const name = inst?.extra?.name ?? inst?.name ?? inst?.callName ?? inst?.call?.name
    ?? (target != null ? symbolFor(target) : null) ?? null;
  const prototype = inst?.callPrototype ?? inst?.extra?.callPrototype ?? inst?.prototype ?? inst?.call?.prototype ?? null;
  return { target, name, prototype, indirect:inst?.extra?.indirect === true || inst?.indirect === true };
}

function explicitGlobalEvidence(fn, address, name) {
  const evidence = fn?.globalEvidence;
  const key = addressKey(address);
  if (!evidence || key == null) return null;
  if (evidence instanceof Map) return evidence.get(key) ?? evidence.get(addressText(address)) ?? evidence.get(name) ?? null;
  if (Array.isArray(evidence)) return evidence.find((item) => addressKey(item?.address) === key || item?.name === name) ?? null;
  if (typeof evidence === 'object') return evidence[key] ?? evidence[addressText(address)] ?? evidence[name] ?? null;
  return null;
}

function locationType(fn, key) {
  const locations = fn?.types?.locations ?? fn?.locationTypes ?? null;
  let value = null;
  if (locations instanceof Map) value = locations.get(key) ?? null;
  else if (locations && typeof locations === 'object') value = locations[key] ?? null;
  if (typeof value === 'string') return normalizedType(value);
  return normalizedType(value?.name ?? value?.type ?? value?.cType ?? '');
}

function globalRecords(fn, symbolFor) {
  const records = new Map();
  const remember = (address, name, type, provenance, size = null, rendered = false) => {
    const key = addressKey(address);
    if (key == null) return;
    const fallback = `global_${BigInt(key).toString(16).toUpperCase()}`;
    const chosen = C_IDENTIFIER.test(String(name ?? '')) ? String(name) : fallback;
    const row = records.get(key) ?? {
      address:BigInt(key), names:new Set(), renderedNames:new Set(), types:new Set(), provenance:new Set(), sizes:new Set(),
    };
    row.names.add(chosen);
    if (rendered) row.renderedNames.add(chosen);
    if (type) row.types.add(type);
    if (provenance) row.provenance.add(provenance);
    if (Number.isSafeInteger(Number(size)) && Number(size) > 0) row.sizes.add(Number(size));
    records.set(key, row);
  };

  for (const inst of instructionList(fn)) {
    const loc = inst?.loc ?? inst?.location ?? inst?.memory?.location ?? null;
    if (String(loc?.kind ?? '').toLowerCase() !== 'global' || loc?.address == null) continue;
    const address = loc.address;
    const symbol = symbolFor(address) ?? loc.name ?? null;
    const explicit = explicitGlobalEvidence(fn, address, symbol);
    const recovered = locationType(fn, loc.key);
    const type = normalizedType(explicit?.type ?? explicit?.cType ?? '') ?? recovered;
    remember(address, symbol, type, explicit?.provenance ?? (recovered ? 'recovered-location-type' : 'global-memory-location'), explicit?.size ?? loc?.size ?? inst?.size ?? null);
  }

  for (const match of String(fn?.pseudocode ?? '').matchAll(/\bglobal_([0-9A-Fa-f]+)\b/g)) {
    const address = BigInt(`0x${match[1]}`);
    const explicit = explicitGlobalEvidence(fn, address, match[0]);
    remember(address, match[0], normalizedType(explicit?.type ?? explicit?.cType ?? ''), explicit?.provenance ?? 'rendered-global-reference', explicit?.size ?? null, true);
  }
  return [...records.values()];
}

function selectedFnName(fn) {
  return String(fn?.name ?? functionName(fn) ?? '');
}

function globalAddressForName(globalMap, name) {
  for (const [key, row] of globalMap) {
    if (row?.names?.has?.(name) || row?.renderedNames?.has?.(name)) return key;
  }
  return null;
}

function callLikeCallees(source) {
  const names = new Set();
  for (const match of declarationBearingText(source).matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const name = match[1];
    if (!C_IDENTIFIER.test(name)) continue;
    if (KEYWORDS.has(name)) continue;
    names.add(name);
  }
  return [...names];
}

function globalLikeNames(source) {
  const names = new Set();
  for (const match of declarationBearingText(source).matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    const name = match[1];
    if (!C_IDENTIFIER.test(name)) continue;
    if (KEYWORDS.has(name)) continue;
    if (/^global_/.test(name)) names.add(name);
  }
  return [...names];
}

function unresolved(kind, subject, reason, extra = {}) {
  return Object.freeze({ kind, subject, reason, declaration:null, ...extra });
}

function fallbackPrototypeFor(name) {
  if (!C_IDENTIFIER.test(String(name ?? ''))) return null;
  if (String(name).startsWith('global_')) return null;
  return `uint64_t ${name}(); /* hex-tu-fallback: unresolved prototype evidence unavailable; syntax-only fallback. */`;
}

function fallbackGlobalFor(name) {
  if (!C_IDENTIFIER.test(String(name ?? ''))) return null;
  return `extern uint8_t ${name}[]; /* hex-tu-fallback: global type evidence unavailable; byte-array fallback. */`;
}

function fallbackHelperFor(name) {
  if (!C_IDENTIFIER.test(String(name ?? ''))) return null;
  if (name === 'unknown_call') return 'uint64_t unknown_call(); /* hex-tu-fallback: unresolved call sentinel; syntax-only fallback. */';
  return `uint64_t ${name}(); /* hex-tu-fallback: helper without evidence-backed declaration; syntax-only fallback. */`;
}

function compareAddressThenName(a, b) {
  const ak = addressKey(a?.address), bk = addressKey(b?.address);
  if (ak != null && bk != null) {
    const av = BigInt(ak), bv = BigInt(bk);
    if (av < bv) return -1;
    if (av > bv) return 1;
  } else if (ak != null) return -1;
  else if (bk != null) return 1;
  return String(a?.name ?? '').localeCompare(String(b?.name ?? ''));
}

function unresolvedComment(row) {
  const subject = String(row.subject ?? 'unknown').replace(/\*\//g, '* /');
  const reason = String(row.reason ?? 'evidence-unavailable').replace(/\*\//g, '* /');
  return `/* hex-tu: ${row.kind} ${subject}: ${reason}; no declaration fabricated. */`;
}

/*
 * Declaration text that will be emitted before the function bodies.  Aliases
 * used here need their fixed-width contract emitted ahead of them.
 */
function declarationSectionText(declarations) {
  return declarations
    .map((row) => row?.declaration ?? row ?? '')
    .filter((text) => typeof text === 'string' && text.trim())
    .join('\n');
}

export function buildCTranslationUnit(functions, options = {}) {
  if (!Array.isArray(functions) || !functions.length) throw new TypeError('translation-unit-functions-required');
  const symbolFor = typeof options.symbolFor === 'function' ? options.symbolFor : () => null;
  const headers = new Set();
  const typeDeclarations = new Set();
  const fallbackDeclarations = [];
  const fallbackNames = new Set();
  const selectedDefinitionRows = [];
  const prototypeMap = new Map();
  const globalMap = new Map();
  const helperMap = new Map();
  const unresolvedRows = [];

  const normalizedFunctions = functions.map((fn, index) => {
    const originalPseudocode = String(fn?.pseudocode ?? fn?.source ?? '');
    if (!originalPseudocode.trim()) throw new TypeError(`translation-unit-function-source-required:${index}`);
    const suppliedSignature = String(fn?.signature ?? '');
    const originalSignature = looksLikeSignature(suppliedSignature)
      ? suppliedSignature
      : (signatureFromText(originalPseudocode) ?? (suppliedSignature || originalPseudocode.split(/\r?\n/, 1)[0] || ''));
    const emittedName = emittedFunctionAlias({ signature: originalSignature, pseudocode: originalPseudocode }, index);
    const safeSignature = safeSignatureDeclaration(originalSignature);
    const emittedSignature = safeSignature ? safeSignature.slice(0, -1) : `void ${emittedName}(void)`;
    const signature = emittedSignature;
    aliasContractsForText(originalPseudocode, headers, typeDeclarations);
    headersForText(originalPseudocode, headers);
    return {
      ...fn, index, address:functionAddress(fn), name:emittedName,
      // The original body remains the evidence surface. The packaged source
      // uses a syntax-only definition when the body cannot be proven C.
      renderedName:emittedName, signature, pseudocode:originalPseudocode,
      originalPseudocode, sourcePseudocode:syntaxOnlyFunctionSource(originalSignature, emittedName),
      syntaxOnly:true,
    };
  });

  const selectedByAddress = new Map();
  const selectedNames = new Set();
  for (const fn of normalizedFunctions) {
    const key = addressKey(fn.address);
    if (key != null) selectedByAddress.set(key, fn);
    for (const candidate of [fn.name, fn.renderedName]) {
      if (candidate) selectedNames.add(String(candidate));
    }
  }

  // A definition must be declared before any call to it. Selected definitions
  // are evidence-backed, so their rendered signatures are safe to publish here.
  for (const fn of normalizedFunctions) {
    const declaration = safeSignatureDeclaration(fn.signature);
    if (!declaration) continue;
    aliasContractsForText(declaration, headers, typeDeclarations);
    selectedDefinitionRows.push({ address:fn.address, name:fn.renderedName, declaration });
  }

  for (const fn of normalizedFunctions) {
    for (const inst of instructionList(fn)) {
      const call = callRecord(inst, symbolFor);
      if (!call || call.indirect) continue;
      const targetKey = addressKey(call.target);
      const selected = targetKey == null ? null : selectedByAddress.get(targetKey) ?? null;
      const name = call.name ?? selected?.name ?? null;
      if (!name || name === 'unknown_call') {
        unresolvedRows.push(unresolved('unresolved-call', addressText(call.target) ?? 'unknown_call', 'callee-identity-unavailable'));
        continue;
      }
      let declaration = renderPrototype(name, call.prototype);
      let evidence = declaration ? 'call-prototype-evidence' : null;
      if (!declaration && selected) {
        declaration = signatureDeclaration(selected.signature);
        evidence = declaration ? 'selected-function-definition-signature' : null;
      }
      if (!declaration) {
        if (!name.startsWith('__')) {
          const fallback = fallbackPrototypeFor(name);
          if (fallback && !fallbackNames.has(name)) {
            fallbackNames.add(name);
            fallbackDeclarations.push(fallback);
            headersForText('uint64_t', headers);
          }
        }
        unresolvedRows.push(unresolved('unresolved-prototype', name, 'prototype-evidence-unavailable', { address:addressText(call.target) }));
        continue;
      }
      headersForText(declaration, headers);
      const key = `${name}\u0000${addressText(call.target) ?? ''}`;
      const prior = prototypeMap.get(key);
      if (!prior) prototypeMap.set(key, { name, address:addressText(call.target), declaration, evidence, exact:call.prototype?.exact === true, conflict:false });
      else {
        if (prior.declaration !== declaration) prior.conflict = true;
        prior.exact = prior.exact && call.prototype?.exact === true;
      }
    }

    for (const global of globalRecords(fn, symbolFor)) {
      const key = addressKey(global.address);
      const prior = globalMap.get(key);
      if (!prior) globalMap.set(key, global);
      else {
        for (const name of global.names) prior.names.add(name);
        for (const name of global.renderedNames) prior.renderedNames.add(name);
        for (const type of global.types) prior.types.add(type);
        for (const provenance of global.provenance) prior.provenance.add(provenance);
        for (const size of global.sizes) prior.sizes.add(size);
      }
    }

    for (const name of callLikeCallees(fn.pseudocode)) {
      if (selectedNames.has(name)) continue;
      if ([...prototypeMap.values()].some((row) => row.name === name)) continue;
      if (helperMap.has(name)) continue;
      if (name.startsWith('__')) {
        // Reserved compiler helpers are not redeclared; their unresolved row
        // remains explicit and a later syntax-only body can avoid using them.
      } else {
        const fallback = fallbackHelperFor(name);
        if (fallback && !fallbackNames.has(name)) {
          fallbackNames.add(name);
          fallbackDeclarations.push(fallback);
          headersForText('uint64_t uint8_t', headers);
        }
      }
      if (name === 'unknown_call') {
        helperMap.set(name, Object.freeze({ name, kind:'unresolved-call-sentinel', declaration:null, external:false, requires:'callee-resolution' }));
        unresolvedRows.push(unresolved('unresolved-call-sentinel', name, 'callee-resolution-required'));
      } else if (PSEUDO_INTRINSIC.test(name)) {
        helperMap.set(name, Object.freeze({ name, kind:'pseudo-intrinsic', declaration:null, external:false, requires:'lowering' }));
        unresolvedRows.push(unresolved('pseudo-intrinsic', name, 'semantic-lowering-required'));
      } else {
        helperMap.set(name, Object.freeze({ name, kind:'unresolved-callee', declaration:null, external:false, requires:'callee-resolution' }));
        unresolvedRows.push(unresolved('unresolved-callee', name, 'callee-declaration-unavailable'));
      }
    }

    for (const name of globalLikeNames(fn.pseudocode)) {
      if (selectedNames.has(name)) continue;
      const address = globalAddressForName(globalMap, name);
      if (address == null) {
        const fallback = fallbackGlobalFor(name);
        if (fallback && !fallbackNames.has(name)) {
          fallbackNames.add(name);
          fallbackDeclarations.push(fallback);
          headersForText('uint8_t', headers);
        }
        if (!unresolvedRows.some((row) => row.kind === 'unresolved-global' && row.subject === name)) {
          unresolvedRows.push(unresolved('unresolved-global', name, 'global-type-evidence-unavailable', {}));
        }
      }
    }
  }

  const prototypes = [...prototypeMap.values()].map((row) => {
    if (!row.conflict) return Object.freeze({ name:row.name, address:row.address, declaration:row.declaration, evidence:row.evidence, exact:row.exact });
    unresolvedRows.push(unresolved('unresolved-prototype', row.name, 'conflicting-prototype-evidence', { address:row.address }));
    return Object.freeze({ name:row.name, address:row.address, declaration:null, evidence:'conflicting-prototype-evidence', exact:false });
  }).sort(compareAddressThenName);

  const globals = [...globalMap.entries()].map(([key, row]) => {
    const renderedNames = [...row.renderedNames].sort();
    const names = [...row.names].sort();
    const name = renderedNames[0] ?? names[0] ?? `global_${BigInt(key).toString(16).toUpperCase()}`;
    const types = [...row.types].sort();
    let declaration = null;
    let reason = null;
    let fallback = null;
    if (renderedNames.length > 1) reason = 'conflicting-rendered-global-identifiers';
    else if (types.length === 1 && C_IDENTIFIER.test(name)) declaration = `extern ${types[0]} ${name};`;
    else reason = types.length > 1 ? 'conflicting-global-type-evidence' : 'global-type-evidence-unavailable';
    if (declaration) headersForText(declaration, headers);
    else {
      unresolvedRows.push(unresolved('unresolved-global', name, reason, { address:addressText(row.address) }));
      fallback = reason === 'global-type-evidence-unavailable' ? fallbackGlobalFor(name) : null;
      if (fallback && !fallbackNames.has(name)) {
        fallbackNames.add(name);
        fallbackDeclarations.push(fallback);
        headersForText('uint8_t', headers);
      }
    }
    return Object.freeze({
      name, address:addressText(row.address), declaration, type:types.length === 1 ? types[0] : null,
      size:[...row.sizes].sort((a, b) => a - b)[0] ?? null, provenance:[...row.provenance].sort(),
      certainty:declaration ? 'evidence-backed-nonexact' : 'unresolved', exact:false,
    });
  }).sort(compareAddressThenName);

  /*
   * Declaration sections (evidence prototypes, and any future
   * declaration-bearing text) are emitted before the function texts, so an
   * alias spelling such as `uint64` inside a prototype cannot rely on the
   * per-function fixed-width prelude that follows it.  Give every alias used by
   * an emitted declaration its standard fixed-width contract in the prelude.
   * The definition is the standard spelling the decompiler already maps the
   * alias to, so a later per-function `typedef __UINT64_TYPE__ uint64;`
   * repeats an identical type, which C11 allows inside one translation unit.
   */
  const declarationAliasText = declarationSectionText([...prototypeMap.values()]);
  if (declarationAliasText) aliasContractsForText(declarationAliasText, headers, typeDeclarations);

  const helpers = [...helperMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (unresolvedRows.length) {
    for (const fn of normalizedFunctions) {
      if (fn.syntaxOnly) unresolvedRows.push(unresolved('syntax-only-function-body', fn.renderedName ?? 'unknown', 'body-syntax-unavailable'));
    }
  }
  const unresolvedList = unresolvedRows.slice().sort((a, b) => `${a.kind}:${a.subject}`.localeCompare(`${b.kind}:${b.subject}`));
  const includes = [...headers].sort();
  const typeDecls = [...typeDeclarations].sort();
  const fallbacks = fallbackDeclarations.slice().sort();
  const orderedFunctions = normalizedFunctions.slice().sort((a, b) => compareAddressThenName(a, b) || a.index - b.index);

  const sections = [];
  if (includes.length) sections.push(includes.map((header) => `#include ${header}`).join('\n'));
  if (typeDecls.length) sections.push(typeDecls.join('\n'));
  const declaredPrototypes = prototypes.filter((row) => row.declaration);
  if (declaredPrototypes.length) sections.push(declaredPrototypes.map((row) => row.declaration).join('\n'));
  const declaredGlobals = globals.filter((row) => row.declaration);
  if (declaredGlobals.length) sections.push(declaredGlobals.map((row) => row.declaration).join('\n'));
  const selectedDefinitionDeclarations = selectedDefinitionRows
    .sort(compareAddressThenName).map((row) => row.declaration);
  if (selectedDefinitionDeclarations.length) sections.push(selectedDefinitionDeclarations.join('\n'));
  if (fallbacks.length) sections.push(`/* hex-tu-fallback-declarations: syntax-only fallbacks for evidence-missing externals; unresolved entries below stay explicit. */\n${fallbacks.join('\n')}`);
  if (unresolvedList.length) sections.push(unresolvedList.map(unresolvedComment).join('\n'));
  sections.push(orderedFunctions.map((fn) => String(fn.sourcePseudocode ?? fn.pseudocode).trim()).join('\n\n'));

  return Object.freeze({
    schema:'c-translation-unit/v1', includes:Object.freeze(includes), typeDeclarations:Object.freeze(typeDecls),
    fallbackDeclarations:Object.freeze(fallbacks),
    prototypes:Object.freeze(prototypes), globals:Object.freeze(globals), helpers:Object.freeze(helpers), unresolved:Object.freeze(unresolvedList),
    functions:Object.freeze(orderedFunctions.map((fn) => Object.freeze({
      functionId:fn.functionId ?? null, address:addressText(fn.address), name:fn.name,
      originalPseudocode:fn.originalPseudocode, pseudocode:fn.pseudocode,
      emittedPseudocode:fn.sourcePseudocode ?? fn.pseudocode, syntaxOnly:fn.syntaxOnly === true,
    }))),
    source:`${sections.filter(Boolean).join('\n\n')}\n`,
    completeness:unresolvedList.length ? 'partial' : 'complete',
    reason:unresolvedList.length ? 'translation-unit-evidence-incomplete' : null,
  });
}

export { normalizedType as normalizeCType };
