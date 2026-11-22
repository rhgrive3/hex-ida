/*
 * Final public C output closure.
 *
 * The text a caller copies out of a result must be a C unit that parses on its
 * own, as far as function-local storage, member-base structs, standalone
 * external globals, and type spelling are concerned.  Four closures run on the
 * already-final public lines, after every textual producer (semantic emitter,
 * legacy emitter, switch/loop repair, ARM64 raw lowering) has finished:
 *
 *   1. Fixed-width type prelude.  Emitted C uses the decompiler's own spelling
 *      for integer types (`uint64`, `int32`, ...) and, inside expressions, the
 *      stdint spelling (`uint64_t`, ...).  Neither is a built-in C type.  The
 *      prelude defines exactly the names the function text uses, in terms of
 *      exactly-sized built-in types, so the emitted function needs no system
 *      header to parse.  It is emitted once per function, before the
 *      signature, and identical typedef repetition is valid C11 inside one
 *      translation unit, so concatenated functions still parse.
 *
 *   2. Member-base struct & pointer/value closure.  When an undeclared
 *      identifier is used as a member base (`a1->field_0`, `s.field_0`), a
 *      minimal deterministic `typedef struct { uint64 field_0; ... } hex_struct_<name>;`
 *      is emitted before the signature and `<type> *<name>;` (for `->`) or
 *      `<type> <name>;` (for `.` only) is declared at the top of the body.
 *
 *   3. Standalone external globals.  Undeclared `global_*` value references
 *      receive a clearly-marked `extern uint64 global_XXXX;` prelude block
 *      before the signature so single-function output compiles standalone.
 *      The translation unit packager strips that prelude block and retains its
 *      own evidence-backed / byte-array fallback global contract.
 *
 *   4. Local declarations.  Every identifier the final text reads or writes
 *      that has no declaration anywhere in the function is declared once at
 *      the top of the body.  The declared type is the recovered type when the
 *      result carries one that is safe to spell, and otherwise the explicit
 *      sized fallback implied by the producer's own naming: register class
 *      (x/w -> 64/32, d -> 64, s -> 32, q/v -> 128), recovered stack slot
 *      width, or 64-bit for an untyped temporary.
 *
 * Deliberately out of scope here:
 *   - callees (`sub_*`, named functions) and pseudo-intrinsics are not
 *     declared by this closure.  The translation unit packager owns those
 *     declarations: it sees every selected function and evidence-based
 *     prototypes, while a per-function declaration could contradict that
 *     evidence.  They stay visible exactly as emitted.
 *
 * Provenance: every injected line is bound to the signature's own origin
 * (its source, or its row/address when the legacy path carries no source
 * object).  The declaration exists because the function uses the name, so
 * the function entry is its honest origin; a zero-origin injected line
 * would publish render-provenance loss.
 */

import { sourceOf, mergeSource } from './ast/nodes.js';

const KEYWORDS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double',
  'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long',
  'register', 'restrict', 'return', 'short', 'signed', 'sizeof', 'static', 'struct',
  'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while', '_Bool', 'bool',
  '_Static_assert', '__asm', '__asm__', 'asm', 'true', 'false', 'NULL',
]);

/*
 * Alias -> exactly-sized definition, in emission order.
 *
 * The definitions use the compiler's own fixed-width model macros rather than
 * spelling `unsigned long long`: that spelling is exactly what <stdint.h>
 * itself expands to on GCC/Clang, so a translation unit that later includes
 * <stdint.h>/<stddef.h> sees identical typedefs instead of a conflicting
 * redefinition.  The names are emitted only when the text uses them, and the
 * prelude is self-contained, so a single emitted function parses with no
 * system header at all.  `bool` is deliberately absent: <stdbool.h> defines it
 * as a macro, so an emitted typedef could not coexist with that header.
 */
const FIXED_WIDTH_TYPES = Object.freeze(new Map([
  ['uint8', '__UINT8_TYPE__'], ['int8', '__INT8_TYPE__'],
  ['uint16', '__UINT16_TYPE__'], ['int16', '__INT16_TYPE__'],
  ['uint32', '__UINT32_TYPE__'], ['int32', '__INT32_TYPE__'],
  ['uint64', '__UINT64_TYPE__'], ['int64', '__INT64_TYPE__'],
  ['uint8_t', '__UINT8_TYPE__'], ['int8_t', '__INT8_TYPE__'],
  ['uint16_t', '__UINT16_TYPE__'], ['int16_t', '__INT16_TYPE__'],
  ['uint32_t', '__UINT32_TYPE__'], ['int32_t', '__INT32_TYPE__'],
  ['uint64_t', '__UINT64_TYPE__'], ['int64_t', '__INT64_TYPE__'],
  ['uintptr_t', '__UINTPTR_TYPE__'], ['intptr_t', '__INTPTR_TYPE__'],
  ['size_t', '__SIZE_TYPE__'], ['ptrdiff_t', '__PTRDIFF_TYPE__'],
  ['uint128', 'unsigned __int128'], ['int128', '__int128'],
  ['vector128', 'unsigned __int128'],
]));

const PRELUDE_COMMENT = '/* hex: fixed-width integer types (self-contained; standard names stay identical to <stdint.h>). */';
const STRUCT_PRELUDE_COMMENT = '/* hex: synthesized member-base structs. */';
const STANDALONE_GLOBALS_COMMENT = '/* hex: standalone external globals (stripped by translation unit packager). */';

const SIMPLE_DECLARABLE = /^(?:unsigned\s+)?(?:char|short|int|long|long\s+long|long\s+long\s+int|__int128)$|^void \*$/;

export function isFixedWidthTypeName(name) {
  return FIXED_WIDTH_TYPES.has(String(name ?? ''));
}

/* True only for one exact line of the fixed-width prelude that
 * `fixedWidthPreludeLines` emits (`typedef <builtin> <alias>;`). */
export function isFixedWidthPreludeDeclaration(text) {
  const match = /^typedef\s+(.+?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*;$/.exec(String(text ?? '').trim());
  return !!match && FIXED_WIDTH_TYPES.get(match[2]) === match[1].replace(/\s+/g, ' ');
}

/* Parse a synthesized member-base struct typedef emitted by this closure:
 * `typedef struct { uint64 field_0; ... } hex_struct_<name>;` */
export function parseSynthesizedStructPreludeDeclaration(text) {
  const trimmed = String(text ?? '').trim();
  const match = /^typedef\s+struct\s*\{\s*([^}]+?)\s*\}\s*(hex_struct_[A-Za-z0-9_]+)\s*;$/.exec(trimmed);
  if (!match) return null;
  const body = match[1].trim();
  const name = match[2];
  const fields = [];
  for (const part of body.split(';')) {
    const item = part.trim();
    if (!item) continue;
    const fieldMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(item);
    if (!fieldMatch || !FIXED_WIDTH_TYPES.has(fieldMatch[1]) || KEYWORDS.has(fieldMatch[2])) return null;
    fields.push({ type: fieldMatch[1], name: fieldMatch[2] });
  }
  if (!fields.length) return null;
  return { name, fields };
}

export function isSynthesizedStructPreludeDeclaration(text) {
  return parseSynthesizedStructPreludeDeclaration(text) !== null;
}

export function isStandaloneGlobalPreludeComment(text) {
  return String(text ?? '').trim() === STANDALONE_GLOBALS_COMMENT;
}

export function isStandaloneGlobalPreludeDeclaration(text) {
  const match = /^extern\s+([A-Za-z_][A-Za-z0-9_]*)\s+(global_[A-Za-z0-9_]+)\s*;$/.exec(String(text ?? '').trim());
  return !!match && FIXED_WIDTH_TYPES.has(match[1]);
}

/* Remove comments and literals so identifier scans never read prose or asm
 * text.  Newlines are preserved so callers can still reason about lines. */
export function declarationBearingSource(text) {
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
      if (ch >= '0' && ch <= '9' && (i === 0 || !/[A-Za-z0-9_]/.test(source[i - 1]))) {
        const isHex = ch === '0' && (next === 'x' || next === 'X');
        let j = i;
        while (j < source.length) {
          const c = source[j];
          if (/[0-9A-Za-z_.']/.test(c)) {
            const isExp = isHex ? (c === 'p' || c === 'P') : (c === 'e' || c === 'E');
            if (isExp && (source[j + 1] === '+' || source[j + 1] === '-')) {
              j += 2;
              continue;
            }
            j++;
          } else {
            break;
          }
        }
        out += ' '.repeat(j - i);
        i = j - 1;
        continue;
      }
      out += ch;
      continue;
    }
    if (state === 'line') { if (ch === '\n') { out += '\n'; state = 'code'; } else out += ' '; continue; }
    if (state === 'block') {
      if (ch === '*' && next === '/') { out += '  '; i++; state = 'code'; }
      else out += ch === '\n' ? '\n' : ' ';
      continue;
    }
    if (ch === '\\') { out += '  '; i++; continue; }
    if ((state === 'string' && ch === '"') || (state === 'char' && ch === "'")) { out += ' '; state = 'code'; }
    else out += ch === '\n' ? '\n' : ' ';
  }
  return out;
}


function previousWord(source, index) {
  let at = index - 1;
  while (at >= 0 && /\s/.test(source[at])) at--;
  const end = at + 1;
  while (at >= 0 && /[A-Za-z0-9_]/.test(source[at])) at--;
  return source.slice(at + 1, end);
}

function previousChar(source, index) {
  let at = index - 1;
  while (at >= 0 && /\s/.test(source[at])) at--;
  return at < 0 ? '' : source[at];
}

function nextChar(source, index) {
  let at = index;
  while (at < source.length && /\s/.test(source[at])) at++;
  return at >= source.length ? '' : source[at];
}

/*
 * A C label begins a statement, so the identifier must start a line (or follow
 * `{`, `}`, `;` or another label).  A colon after an expression is a ternary or
 * bit-field colon, not a label: `... ? (uint32)x2 : 1` must not classify `x2`
 * as a label, because a label is never a declarable local.
 */
function startsStatement(source, index) {
  let at = index - 1;
  while (at >= 0 && (source[at] === ' ' || source[at] === '\t')) at--;
  if (at < 0) return true;
  const previous = source[at];
  return previous === '\n' || previous === '{' || previous === '}' || previous === ';' || previous === ':';
}

/*
 * One pass over the declaration-bearing source.  For every identifier the pass
 * records how it is used, which is what lets the closure tell an undeclared
 * local from a member name, a label, a cast type or a callee.
 */
export function scanIdentifierUses(text) {
  const source = declarationBearingSource(text);
  const uses = new Map();
  const pattern = /[A-Za-z_][A-Za-z0-9_]*/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const name = match[0];
    const start = match.index;
    const end = start + name.length;
    const before = previousChar(source, start);
    const after = nextChar(source, end);
    const memberName = before === '.' || source.slice(0, start).trimEnd().endsWith('->');
    const memberBase = after === '.' || source.slice(end).trimStart().startsWith('->');
    const callTarget = after === '(';
    const label = after === ':' && startsStatement(source, start);
    const gotoLabel = previousWord(source, start) === 'goto';
    const isNonPointerCast = (() => {
      if (before !== '(' || after !== ')') return false;
      let openIdx = start - 1;
      while (openIdx >= 0 && /\s/.test(source[openIdx])) openIdx--;
      const wordBeforeOpen = previousWord(source, openIdx);
      if (['if', 'while', 'switch', 'for', 'sizeof', 'typeof', 'alignof', '_Alignof'].includes(wordBeforeOpen)) return false;
      let closeIdx = end;
      while (closeIdx < source.length && /\s/.test(source[closeIdx])) closeIdx++;
      let afterClose = closeIdx + 1;
      while (afterClose < source.length && /\s/.test(source[afterClose])) afterClose++;
      if (afterClose >= source.length) return false;
      const ch = source[afterClose];
      if (/[A-Za-z0-9_~]/.test(ch)) return true;
      if (ch === '!' && source[afterClose + 1] !== '=') return true;
      return false;
    })();
    const isPointerCast = before === '(' && /^\s*\*+\s*\)/.test(source.slice(end));
    const castType = isPointerCast || isNonPointerCast;
    const tag = ['struct', 'union', 'enum'].includes(previousWord(source, start));
    const entry = uses.get(name) ?? {
      name, firstIndex: start, callTarget: false, callTargetOnly: true, memberName: false,
      memberBase: false, label: false, gotoLabel: false, castType: false, tag: false, value: false,
    };
    entry.callTarget ||= callTarget;
    if (!callTarget) entry.callTargetOnly = false;
    entry.memberName ||= memberName;
    entry.memberBase ||= memberBase;
    entry.label ||= label || gotoLabel;
    entry.castType ||= castType;
    entry.tag ||= tag;
    if (!callTarget && !memberName && !label && !gotoLabel && !castType && !tag) entry.value = true;
    uses.set(name, entry);
  }
  return uses;
}

/*
 * Collect all member accesses (`base->field` and `base.field`) on non-member
 * base identifiers from the declaration-bearing source.
 */
function collectMemberBaseAccesses(text) {
  const source = declarationBearingSource(text);
  const accesses = new Map();
  const pattern = /([A-Za-z_][A-Za-z0-9_]*)\s*(->|\.)\s*([A-Za-z_][A-Za-z0-9_]*)/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const base = match[1];
    const op = match[2];
    const field = match[3];
    const start = match.index;
    const before = previousChar(source, start);
    if (before === '.' || source.slice(0, start).trimEnd().endsWith('->')) continue;
    if (['struct', 'union', 'enum', 'goto'].includes(previousWord(source, start))) continue;
    if (KEYWORDS.has(field)) continue;
    let rec = accesses.get(base);
    if (!rec) {
      rec = { fields: new Set(), hasArrow: false, hasDot: false };
      accesses.set(base, rec);
    }
    rec.fields.add(field);
    if (op === '->') rec.hasArrow = true;
    else rec.hasDot = true;
  }
  const ptrArithPattern = /\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*[+-][^()]*\)\s*->\s*([A-Za-z_][A-Za-z0-9_]*)/g;
  for (let match = ptrArithPattern.exec(source); match; match = ptrArithPattern.exec(source)) {
    const base = match[1];
    const field = match[2];
    if (KEYWORDS.has(base) || KEYWORDS.has(field)) continue;
    let rec = accesses.get(base);
    if (!rec) {
      rec = { fields: new Set(), hasArrow: false, hasDot: false };
      accesses.set(base, rec);
    }
    rec.fields.add(field);
    rec.hasArrow = true;
  }
  return accesses;
}


const NON_DECL_STMT_HEADS = new Set([
  'return', 'goto', 'if', 'else', 'for', 'while', 'do', 'switch',
  'case', 'default', 'break', 'continue', 'sizeof',
]);

/* Names a declaration line, stmt-kind local declaration, or prelude typedef line introduces. */
function declaredNamesFromLines(lines) {
  const declared = new Set();
  for (const item of lines || []) {
    if (item?.kind === 'decl') {
      for (const match of declarationBearingSource(item.text).matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) declared.add(match[0]);
      continue;
    }
    if (item?.kind === 'stmt') {
      const cleaned = declarationBearingSource(item.text).trim();
      if (/^typedef\b/.test(cleaned)) {
        const aliasMatch = /\b([A-Za-z_][A-Za-z0-9_]*)\s*;$/.exec(cleaned);
        if (aliasMatch && !KEYWORDS.has(aliasMatch[1])) declared.add(aliasMatch[1]);
        const tagMatch = /\b(?:struct|union|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(cleaned);
        if (tagMatch && !KEYWORDS.has(tagMatch[1])) declared.add(tagMatch[1]);
        continue;
      }
      const match = /^(?:(?:const|volatile|static|extern|register|unsigned|signed|short|long|struct|union|enum)\s+)*([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:\*+\s*)*|\s*\*+\s*)([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|;|\[|,)/.exec(cleaned);
      if (match && !NON_DECL_STMT_HEADS.has(match[1]) && !KEYWORDS.has(match[2])) {
        declared.add(match[1]);
        declared.add(match[2]);
      }
    }
  }
  return declared;
}

/* Type names appearing in a function signature (return type and parameter types). */
function signatureTypeNames(signature) {
  const names = new Set();
  const text = declarationBearingSource(signature);
  const open = text.indexOf('(');
  if (open < 0) return names;
  const retTokens = [...text.slice(0, open).matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => m[0]);
  for (let i = 0; i < retTokens.length - 1; i++) names.add(retTokens[i]);
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') { depth--; if (!depth) { close = i; break; } }
  }
  if (close > open) {
    for (const group of text.slice(open + 1, close).split(',')) {
      const tokens = [...group.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => m[0]);
      if (tokens.length >= 2) {
        for (let i = 0; i < tokens.length - 1; i++) names.add(tokens[i]);
      } else if (tokens.length === 1 && !KEYWORDS.has(tokens[0])) {
        names.add(tokens[0]);
      }
    }
  }
  return names;
}

/* Parameter names of `returnType name(uint64 a1, uint32 a2)`, if any. */
export function parameterNames(signature) {
  const text = String(signature ?? '');
  const open = text.indexOf('(');
  if (open < 0) return [];
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') { depth--; if (!depth) { close = i; break; } }
  }
  if (close < 0) return [];
  const names = [];
  for (const group of text.slice(open + 1, close).split(',')) {
    const tokens = [...declarationBearingSource(group).matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => m[0]);
    const name = tokens.filter((token) => !KEYWORDS.has(token) && !FIXED_WIDTH_TYPES.has(token)).at(-1);
    if (name) names.push(name);
  }
  return names;
}

/* Stack slot identity carried by the producer's own local names. */
export function stackOffsetFromName(name) {
  const raw = String(name ?? '');
  let match = /^(?:local_|var_)([0-9A-Fa-f]+)$/.exec(raw) ?? /^local_p([0-9A-Fa-f]+)$/.exec(raw);
  if (match) return BigInt.asIntN(64, BigInt(`0x${match[1]}`));
  match = /^local_m([0-9A-Fa-f]+)$/.exec(raw) ?? /^var_m([0-9A-Fa-f]+)$/.exec(raw);
  if (match) return -BigInt(`0x${match[1]}`);
  return null;
}

const REGISTER_CLASSES = Object.freeze([
  [/^[xX]\d+(?:_\d+)?$/, 'uint64'], [/^[wW]\d+(?:_\d+)?$/, 'uint32'],
  [/^[dD]\d+(?:_\d+)?$/, 'uint64'], [/^[sS]\d+(?:_\d+)?$/, 'uint32'],
  [/^[qQvV]\d+(?:_\d+)?$/, 'uint128'],
  [/^(?:sp|lr|fp|xzr|wzr|nzcv|fpcr|fpsr)$/, 'uint64'],
]);

function registerType(name) {
  for (const [pattern, type] of REGISTER_CLASSES) if (pattern.test(name)) return type;
  const match = /^local_([xwdsqv])\d+$/i.exec(name);
  if (match) return registerType(`${match[1]}0`);
  return null;
}

function sizeType(size, signed) {
  const bits = Number(size) * 8;
  if (![8, 16, 32, 64, 128].includes(bits)) return null;
  return `${signed === true ? 'int' : 'uint'}${bits}`;
}

function recoveredTypeName(type) {
  if (!type) return null;
  if (typeof type === 'string') return type;
  const name = type.name ?? type.type ?? null;
  return typeof name === 'string' && name !== 'unknown' ? name : null;
}

/* Only types this closure can spell without inventing an unrelated
 * declaration are honoured; anything else falls back to the sized built-in. */
function usableRecoveredType(name) {
  if (typeof name !== 'string') return null;
  const text = name.trim().replace(/\s+/g, ' ');
  if (FIXED_WIDTH_TYPES.has(text)) return text;
  return SIMPLE_DECLARABLE.test(text) ? text : null;
}


function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resultEvidence(result) {
  const ir = result?.ir ?? null;
  const types = result?.types ?? null;
  return {
    stackSlots: Array.isArray(ir?.stackSlots) ? ir.stackSlots : [],
    locals: Array.isArray(types?.locals) ? types.locals : [],
    args: Array.isArray(types?.args) ? types.args : [],
    values: types?.values instanceof Map ? types.values : null,
  };
}

function recoveredStackType(name, evidence) {
  const offset = stackOffsetFromName(name);
  if (offset == null) return null;
  const slot = evidence.stackSlots.find((candidate) => {
    try { return BigInt(candidate?.offset ?? candidate?.disp) === offset; } catch { return false; }
  }) ?? null;
  const local = evidence.locals.find((candidate) =>
    candidate?.slot === slot?.name || candidate?.slot === name
    || (() => { try { return BigInt(candidate?.offset) === offset; } catch { return false; } })()) ?? null;
  const recovered = usableRecoveredType(recoveredTypeName(local?.type))
    ?? usableRecoveredType(recoveredTypeName(local?.semanticType));
  if (recovered && FIXED_WIDTH_TYPES.has(recovered)) return recovered;
  return sizeType(slot?.size ?? local?.size, local?.signed === true ? true : slot?.signed) ?? recovered;
}

/*
 * Declared type for one emitted local.  Evidence first (stack slot width or
 * recovered value type), then the naming class the producer itself used, then
 * the explicit 64-bit fallback.  Never a type name this closure cannot spell.
 */
export function localDeclarationTypeFor(name, result) {
  const evidence = resultEvidence(result);
  const stack = recoveredStackType(name, evidence);
  if (stack) return stack;
  const register = registerType(name);
  if (register) return register;
  const argument = /^a(\d+)$/.exec(name);
  if (argument) {
    const index = Number(argument[1]) - 1;
    const entry = evidence.args.find((candidate) => Number(candidate?.index) === index);
    const recovered = usableRecoveredType(recoveredTypeName(entry?.type));
    if (recovered) return recovered;
  }
  const temporary = /^(?:load|call)_(\d+)$/.exec(name);
  if (temporary && evidence.values) {
    const recovered = usableRecoveredType(recoveredTypeName(evidence.values.get(Number(temporary[1]))));
    if (recovered) return recovered;
  }
  return 'uint64';
}

function isDeclarableLocal(entry, declared) {
  const name = entry?.name;
  if (!name || !entry.value || declared.has(name)) return false;
  if (KEYWORDS.has(name) || FIXED_WIDTH_TYPES.has(name)) return false;
  if (entry.callTarget || entry.memberName || entry.memberBase || entry.castType || entry.tag) return false;
  if (entry.label || entry.gotoLabel) return false;
  // External symbols and pseudo-intrinsics are never fabricated as function-local variables.
  if (/^global_/.test(name)) return false;
  if (/^(?:sub_|func_|fn_|unknown_call$|loc_|__)/.test(name)) return false;
  return true;
}

function isDeclarableMemberBase(entry, declared) {
  const name = entry?.name;
  if (!name || !entry.memberBase || declared.has(name)) return false;
  if (KEYWORDS.has(name) || FIXED_WIDTH_TYPES.has(name)) return false;
  if (entry.callTarget || entry.memberName || entry.castType || entry.tag) return false;
  if (entry.label || entry.gotoLabel) return false;
  if (/^global_/.test(name)) return false;
  if (/^(?:sub_|func_|fn_|unknown_call$|loc_|__)/.test(name)) return false;
  return true;
}

function isDeclarableStandaloneGlobal(entry, declared) {
  const name = entry?.name;
  if (!name || !entry.value || declared.has(name)) return false;
  if (!/^global_[A-Za-z0-9_]+$/.test(name)) return false;
  if (KEYWORDS.has(name) || FIXED_WIDTH_TYPES.has(name)) return false;
  if (entry.callTarget || entry.memberName || entry.castType || entry.tag) return false;
  if (entry.label || entry.gotoLabel) return false;
  return true;
}

function compareAscii(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function renderedText(lines) {
  return (lines || []).map((item) => `${'    '.repeat(Math.max(0, item.indent || 0))}${item.text || ''}`).join('\n');
}

/*
 * Origin for closure-injected declaration lines: the signature line's own
 * source, extended with the signature's row/address when the source object
 * carries neither.  Legacy results keep row/addr on the line but no `source`
 * object; without this fallback the injected lines would render with zero
 * origins and be reported as provenance loss.
 */
function entryOriginSource(sigLine) {
  const base = sourceOf(sigLine?.source ?? null);
  return mergeSource(base, {
    addresses: base.addresses.length || sigLine?.addr == null ? [] : [sigLine.addr],
    rows: base.rows.length || sigLine?.row == null ? [] : [sigLine.row],
  });
}

function definedTypeAliases(lines) {
  const defined = new Set();
  for (const item of lines || []) {
    if (item?.kind !== 'decl' && item?.kind !== 'stmt') continue;
    const cleaned = declarationBearingSource(item.text);
    const match = /^\s*typedef\b[\s\S]*?\b([A-Za-z_][A-Za-z0-9_]*)\s*;\s*$/.exec(cleaned);
    if (match) defined.add(match[1]);
  }
  return defined;
}

/*
 * Fixed-width prelude for exactly the alias names `text` uses and no existing
 * declaration already defines.  Deterministic order; no output when the text
 * is already self-contained.
 */
export function fixedWidthPreludeLines(text, alreadyDefined = new Set()) {
  const source = declarationBearingSource(text);
  const lines = [];
  for (const [alias, builtin] of FIXED_WIDTH_TYPES) {
    if (alreadyDefined.has(alias)) continue;
    if (!new RegExp(`\\b${escapeRegExp(alias)}\\b`).test(source)) continue;
    if (!lines.length) lines.push({ kind: 'decl', indent: 0, text: PRELUDE_COMMENT, row: null, addr: null, note: null });
    lines.push({ kind: 'decl', indent: 0, text: `typedef ${builtin} ${alias};`, row: null, addr: null, note: null });
  }
  return lines;
}

/*
 * Apply the closure to a finished public result.  The result is updated in
 * place (`lines` plus the rendered `pseudocode`) and returned.  `options.render`
 * is the caller's own line renderer so the published text keeps that call
 * site's exact spelling.  `options.onLinesChanged` lets the caller refresh any
 * derived artifact (for example an index-keyed render provenance map) after the
 * line array changed.
 */
export function closeFunctionOutput(result, options = {}) {
  if (!result || !Array.isArray(result.lines) || !result.lines.length) return result;
  const render = typeof options.render === 'function' ? options.render : renderedText;
  const lines = result.lines;
  const sigIndex = lines.findIndex((item) => item?.kind === 'sig');
  if (sigIndex < 0) return result;

  const declared = declaredNamesFromLines(lines);
  const sigText = String(lines[sigIndex].text ?? '');
  for (const name of parameterNames(sigText)) declared.add(name);
  for (const name of signatureTypeNames(sigText)) declared.add(name);
  const renderedInitial = render(lines);
  const uses = scanIdentifierUses(renderedInitial);
  const entrySource = entryOriginSource(lines[sigIndex]);
  const bodyOpen = lines.findIndex((item, index) => index > sigIndex && item?.kind === 'ctrl' && item?.text === '{');
  const existingTypes = definedTypeAliases(lines);

  const memberBaseAccesses = collectMemberBaseAccesses(renderedInitial);
  for (const baseName of memberBaseAccesses.keys()) {
    const useEntry = uses.get(baseName);
    if (useEntry) useEntry.memberBase = true;
  }
  const structPrelude = [];
  const memberBaseDeclarations = [];
  if (bodyOpen >= 0) {
    const memberBases = [...uses.values()]
      .filter((entry) => isDeclarableMemberBase(entry, declared))
      .sort((a, b) => compareAscii(a.name, b.name));
    for (const entry of memberBases) {
      const access = memberBaseAccesses.get(entry.name);
      if (!access || !access.fields.size) continue;
      const structType = `hex_struct_${entry.name}`;
      if (!existingTypes.has(structType)) {
        const fieldsText = [...access.fields].sort(compareAscii).map((field) => `uint64 ${field};`).join(' ');
        if (!structPrelude.length) {
          structPrelude.push({ kind: 'decl', indent: 0, text: STRUCT_PRELUDE_COMMENT, row: null, addr: null, note: null, source: entrySource });
        }
        structPrelude.push({
          kind: 'decl', indent: 0, text: `typedef struct { ${fieldsText} } ${structType};`,
          row: null, addr: null, note: null, source: entrySource,
        });
      }
      const declText = access.hasArrow ? `${structType} *${entry.name};` : `${structType} ${entry.name};`;
      memberBaseDeclarations.push({
        kind: 'decl', indent: 1, text: declText,
        row: null, addr: null, note: null, source: entrySource,
      });
    }
  }

  const standaloneGlobals = [...uses.values()]
    .filter((entry) => isDeclarableStandaloneGlobal(entry, declared))
    .sort((a, b) => compareAscii(a.name, b.name));
  const globalPrelude = [];
  if (standaloneGlobals.length) {
    globalPrelude.push({ kind: 'decl', indent: 0, text: STANDALONE_GLOBALS_COMMENT, row: null, addr: null, note: null, source: entrySource });
    for (const entry of standaloneGlobals) {
      globalPrelude.push({
        kind: 'decl', indent: 0, text: `extern uint64 ${entry.name};`,
        row: null, addr: null, note: null, source: entrySource,
      });
    }
  }

  const localDeclarations = [...uses.values()]
    .filter((entry) => isDeclarableLocal(entry, declared))
    .map((entry) => ({
      kind: 'decl', indent: 1, text: `${localDeclarationTypeFor(entry.name, result)} ${entry.name};`,
      row: null, addr: null, note: null, source: entrySource,
    }));

  const allBodyDeclarations = [...memberBaseDeclarations, ...localDeclarations];
  const withDeclarations = allBodyDeclarations.length && bodyOpen >= 0
    ? [...lines.slice(0, bodyOpen + 1), ...allBodyDeclarations, ...lines.slice(bodyOpen + 1)]
    : lines;

  const withPostFixedPrelude = [...withDeclarations];
  const postFixedPrelude = [...structPrelude, ...globalPrelude];
  if (postFixedPrelude.length) withPostFixedPrelude.splice(sigIndex, 0, ...postFixedPrelude);

  const prelude = fixedWidthPreludeLines(render(withPostFixedPrelude), existingTypes)
    .map((item) => ({ ...item, source: entrySource }));
  if (!allBodyDeclarations.length && !postFixedPrelude.length && !prelude.length) return result;

  const next = [...withPostFixedPrelude];
  if (prelude.length) next.splice(sigIndex, 0, ...prelude);
  result.lines = next;
  result.pseudocode = render(next);
  if (typeof options.onLinesChanged === 'function') options.onLinesChanged(result);
  return result;
}
