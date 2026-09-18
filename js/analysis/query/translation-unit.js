/*
 * Compile-oriented C translation-unit packaging.
 *
 * This is deliberately additive.  Function-scoped decompile() keeps returning
 * the same pseudocode presentation; callers that want a C translation unit opt
 * into this packager.  Declarations are emitted only from evidence supplied by
 * the decompiler/analysis layers.  Missing evidence stays explicit and no fake
 * old-style/variadic prototype, scalar global type, or runtime helper is made up
 * just to silence a compiler.
 */

const FIXED_WIDTH_ALIASES = Object.freeze(new Map([
  ['int8', 'int8_t'], ['uint8', 'uint8_t'],
  ['int16', 'int16_t'], ['uint16', 'uint16_t'],
  ['int32', 'int32_t'], ['uint32', 'uint32_t'],
  ['int64', 'int64_t'], ['uint64', 'uint64_t'],
]));

const C_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
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

function pseudoRequirements(source) {
  const names = new Set();
  for (const match of declarationBearingText(source).matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const name = match[1];
    if (name === 'unknown_call' || PSEUDO_INTRINSIC.test(name)) names.add(name);
  }
  return [...names];
}

function unresolved(kind, subject, reason, extra = {}) {
  return Object.freeze({ kind, subject, reason, declaration:null, ...extra });
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

export function buildCTranslationUnit(functions, options = {}) {
  if (!Array.isArray(functions) || !functions.length) throw new TypeError('translation-unit-functions-required');
  const symbolFor = typeof options.symbolFor === 'function' ? options.symbolFor : () => null;
  const headers = new Set();
  const typeDeclarations = new Set();
  const prototypeMap = new Map();
  const globalMap = new Map();
  const helperMap = new Map();
  const unresolvedRows = [];

  const normalizedFunctions = functions.map((fn, index) => {
    const pseudocode = String(fn?.pseudocode ?? fn?.source ?? '');
    if (!pseudocode.trim()) throw new TypeError(`translation-unit-function-source-required:${index}`);
    const signature = String(fn?.signature ?? pseudocode.split(/\r?\n/, 1)[0] ?? '');
    aliasContractsForText(pseudocode, headers, typeDeclarations);
    headersForText(pseudocode, headers);
    return {
      ...fn, index, address:functionAddress(fn), name:functionName({ ...fn, signature, pseudocode }),
      signature, pseudocode, originalPseudocode:pseudocode,
    };
  });

  const selectedByAddress = new Map();
  for (const fn of normalizedFunctions) {
    const key = addressKey(fn.address);
    if (key != null) selectedByAddress.set(key, fn);
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

    for (const name of pseudoRequirements(fn.pseudocode)) {
      if (helperMap.has(name)) continue;
      if (name === 'unknown_call') {
        helperMap.set(name, Object.freeze({ name, kind:'unresolved-call-sentinel', declaration:null, external:false, requires:'callee-resolution' }));
        unresolvedRows.push(unresolved('unresolved-call-sentinel', name, 'callee-resolution-required'));
      } else {
        helperMap.set(name, Object.freeze({ name, kind:'pseudo-intrinsic', declaration:null, external:false, requires:'lowering' }));
        unresolvedRows.push(unresolved('pseudo-intrinsic', name, 'semantic-lowering-required'));
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
    if (renderedNames.length > 1) reason = 'conflicting-rendered-global-identifiers';
    else if (types.length === 1 && C_IDENTIFIER.test(name)) declaration = `extern ${types[0]} ${name};`;
    else reason = types.length > 1 ? 'conflicting-global-type-evidence' : 'global-type-evidence-unavailable';
    if (declaration) headersForText(declaration, headers);
    else unresolvedRows.push(unresolved('unresolved-global', name, reason, { address:addressText(row.address) }));
    return Object.freeze({
      name, address:addressText(row.address), declaration, type:types.length === 1 ? types[0] : null,
      size:[...row.sizes].sort((a, b) => a - b)[0] ?? null, provenance:[...row.provenance].sort(),
      certainty:declaration ? 'evidence-backed-nonexact' : 'unresolved', exact:false,
    });
  }).sort(compareAddressThenName);

  const helpers = [...helperMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  const unresolvedList = unresolvedRows.slice().sort((a, b) => `${a.kind}:${a.subject}`.localeCompare(`${b.kind}:${b.subject}`));
  const includes = [...headers].sort();
  const typeDecls = [...typeDeclarations].sort();
  const orderedFunctions = normalizedFunctions.slice().sort((a, b) => compareAddressThenName(a, b) || a.index - b.index);

  const sections = [];
  if (includes.length) sections.push(includes.map((header) => `#include ${header}`).join('\n'));
  if (typeDecls.length) sections.push(typeDecls.join('\n'));
  const declaredPrototypes = prototypes.filter((row) => row.declaration);
  if (declaredPrototypes.length) sections.push(declaredPrototypes.map((row) => row.declaration).join('\n'));
  const declaredGlobals = globals.filter((row) => row.declaration);
  if (declaredGlobals.length) sections.push(declaredGlobals.map((row) => row.declaration).join('\n'));
  if (unresolvedList.length) sections.push(unresolvedList.map(unresolvedComment).join('\n'));
  sections.push(orderedFunctions.map((fn) => fn.pseudocode.trim()).join('\n\n'));

  return Object.freeze({
    schema:'c-translation-unit/v1', includes:Object.freeze(includes), typeDeclarations:Object.freeze(typeDecls),
    prototypes:Object.freeze(prototypes), globals:Object.freeze(globals), helpers:Object.freeze(helpers), unresolved:Object.freeze(unresolvedList),
    functions:Object.freeze(orderedFunctions.map((fn) => Object.freeze({
      functionId:fn.functionId ?? null, address:addressText(fn.address), name:fn.name,
      originalPseudocode:fn.originalPseudocode, pseudocode:fn.pseudocode,
    }))),
    source:`${sections.filter(Boolean).join('\n\n')}\n`,
    completeness:unresolvedList.length ? 'partial' : 'complete',
    reason:unresolvedList.length ? 'translation-unit-evidence-incomplete' : null,
  });
}

export { normalizedType as normalizeCType };
