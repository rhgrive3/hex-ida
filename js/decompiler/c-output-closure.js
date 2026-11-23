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
const STANDALONE_PROTOTYPES_COMMENT = '/* hex: standalone external prototypes (stripped by translation unit packager). */';
const BITFIELD_HELPERS_COMMENT = '/* hex: bitfield helpers (self-contained; guarded for translation unit inclusion). */';
export const BIT_EXTRACT_HELPER_DEF = 'static inline uint64 bit_extract(uint64 val, unsigned int lsb, unsigned int width) { return (width == 0 || lsb >= 64) ? 0 : (width >= 64 ? (val >> lsb) : ((val >> lsb) & ((1ULL << width) - 1ULL))); }';
export const BIT_INSERT_HELPER_DEF = 'static inline uint64 bit_insert(uint64 dst, uint64 src, unsigned int lsb, unsigned int width) { if (width == 0 || lsb >= 64) return dst; uint64 mask = width >= 64 ? ~0ULL : ((1ULL << width) - 1ULL); return (dst & ~(mask << lsb)) | ((src & mask) << lsb); }';

export const STANDARD_C_LIBRARY_HEADERS = Object.freeze(new Map([
  // <stdlib.h>
  ['malloc', '<stdlib.h>'], ['calloc', '<stdlib.h>'], ['realloc', '<stdlib.h>'], ['free', '<stdlib.h>'],
  ['aligned_alloc', '<stdlib.h>'],
  ['strtol', '<stdlib.h>'], ['strtoul', '<stdlib.h>'], ['strtoll', '<stdlib.h>'], ['strtoull', '<stdlib.h>'],
  ['strtod', '<stdlib.h>'], ['strtof', '<stdlib.h>'], ['strtold', '<stdlib.h>'],
  ['atoi', '<stdlib.h>'], ['atol', '<stdlib.h>'], ['atoll', '<stdlib.h>'], ['atof', '<stdlib.h>'],
  ['abs', '<stdlib.h>'], ['labs', '<stdlib.h>'], ['llabs', '<stdlib.h>'],
  ['div', '<stdlib.h>'], ['ldiv', '<stdlib.h>'], ['lldiv', '<stdlib.h>'],
  ['qsort', '<stdlib.h>'], ['bsearch', '<stdlib.h>'],
  ['exit', '<stdlib.h>'], ['_Exit', '<stdlib.h>'], ['quick_exit', '<stdlib.h>'], ['atexit', '<stdlib.h>'],
  ['abort', '<stdlib.h>'], ['system', '<stdlib.h>'], ['getenv', '<stdlib.h>'],
  ['rand', '<stdlib.h>'], ['srand', '<stdlib.h>'],
  ['mblen', '<stdlib.h>'], ['mbtowc', '<stdlib.h>'], ['wctomb', '<stdlib.h>'],
  ['mbstowcs', '<stdlib.h>'], ['wcstombs', '<stdlib.h>'],
  // <string.h>
  ['strlen', '<string.h>'], ['strnlen', '<string.h>'],
  ['strcpy', '<string.h>'], ['strncpy', '<string.h>'], ['strcat', '<string.h>'], ['strncat', '<string.h>'],
  ['strdup', '<string.h>'], ['strndup', '<string.h>'],
  ['strcmp', '<string.h>'], ['strncmp', '<string.h>'], ['strcoll', '<string.h>'], ['strxfrm', '<string.h>'],
  ['strchr', '<string.h>'], ['strrchr', '<string.h>'], ['strstr', '<string.h>'],
  ['strpbrk', '<string.h>'], ['strspn', '<string.h>'], ['strcspn', '<string.h>'],
  ['strtok', '<string.h>'], ['strtok_r', '<string.h>'], ['strerror', '<string.h>'],
  ['memcpy', '<string.h>'], ['memmove', '<string.h>'], ['memset', '<string.h>'],
  ['memcmp', '<string.h>'], ['memchr', '<string.h>'],
  // <strings.h>
  ['strcasecmp', '<strings.h>'], ['strncasecmp', '<strings.h>'],
  ['bzero', '<strings.h>'], ['bcopy', '<strings.h>'], ['bcmp', '<strings.h>'],
  ['ffs', '<strings.h>'], ['index', '<strings.h>'], ['rindex', '<strings.h>'],
  // <stdio.h>
  ['printf', '<stdio.h>'], ['fprintf', '<stdio.h>'], ['sprintf', '<stdio.h>'], ['snprintf', '<stdio.h>'],
  ['vprintf', '<stdio.h>'], ['vfprintf', '<stdio.h>'], ['vsprintf', '<stdio.h>'], ['vsnprintf', '<stdio.h>'],
  ['scanf', '<stdio.h>'], ['fscanf', '<stdio.h>'], ['sscanf', '<stdio.h>'],
  ['vscanf', '<stdio.h>'], ['vfscanf', '<stdio.h>'], ['vsscanf', '<stdio.h>'],
  ['puts', '<stdio.h>'], ['fputs', '<stdio.h>'], ['putchar', '<stdio.h>'], ['putc', '<stdio.h>'], ['fputc', '<stdio.h>'],
  ['getchar', '<stdio.h>'], ['getc', '<stdio.h>'], ['fgetc', '<stdio.h>'], ['ungetc', '<stdio.h>'],
  ['fgets', '<stdio.h>'], ['getline', '<stdio.h>'],
  ['fopen', '<stdio.h>'], ['freopen', '<stdio.h>'], ['fclose', '<stdio.h>'], ['fflush', '<stdio.h>'],
  ['fread', '<stdio.h>'], ['fwrite', '<stdio.h>'], ['fseek', '<stdio.h>'], ['ftell', '<stdio.h>'], ['rewind', '<stdio.h>'],
  ['fgetpos', '<stdio.h>'], ['fsetpos', '<stdio.h>'], ['feof', '<stdio.h>'], ['ferror', '<stdio.h>'], ['clearerr', '<stdio.h>'],
  ['perror', '<stdio.h>'], ['remove', '<stdio.h>'], ['rename', '<stdio.h>'],
  ['tmpfile', '<stdio.h>'], ['tmpnam', '<stdio.h>'], ['setbuf', '<stdio.h>'], ['setvbuf', '<stdio.h>'], ['fileno', '<stdio.h>'],
  // <math.h>
  ['sqrt', '<math.h>'], ['sqrtf', '<math.h>'], ['sqrtl', '<math.h>'],
  ['cbrt', '<math.h>'], ['cbrtf', '<math.h>'], ['cbrtl', '<math.h>'],
  ['pow', '<math.h>'], ['powf', '<math.h>'], ['powl', '<math.h>'],
  ['hypot', '<math.h>'], ['hypotf', '<math.h>'], ['hypotl', '<math.h>'],
  ['fabs', '<math.h>'], ['fabsf', '<math.h>'], ['fabsl', '<math.h>'],
  ['floor', '<math.h>'], ['floorf', '<math.h>'], ['floorl', '<math.h>'],
  ['ceil', '<math.h>'], ['ceilf', '<math.h>'], ['ceill', '<math.h>'],
  ['round', '<math.h>'], ['roundf', '<math.h>'], ['roundl', '<math.h>'],
  ['lround', '<math.h>'], ['lroundf', '<math.h>'], ['lroundl', '<math.h>'],
  ['llround', '<math.h>'], ['llroundf', '<math.h>'], ['llroundl', '<math.h>'],
  ['trunc', '<math.h>'], ['truncf', '<math.h>'], ['truncl', '<math.h>'],
  ['rint', '<math.h>'], ['rintf', '<math.h>'], ['rintl', '<math.h>'],
  ['lrint', '<math.h>'], ['lrintf', '<math.h>'], ['lrintl', '<math.h>'],
  ['llrint', '<math.h>'], ['llrintf', '<math.h>'], ['llrintl', '<math.h>'],
  ['nearbyint', '<math.h>'], ['nearbyintf', '<math.h>'], ['nearbyintl', '<math.h>'],
  ['fmod', '<math.h>'], ['fmodf', '<math.h>'], ['fmodl', '<math.h>'],
  ['remainder', '<math.h>'], ['remainderf', '<math.h>'], ['remainderl', '<math.h>'],
  ['remquo', '<math.h>'], ['remquof', '<math.h>'], ['remquol', '<math.h>'],
  ['modf', '<math.h>'], ['modff', '<math.h>'], ['modfl', '<math.h>'],
  ['copysign', '<math.h>'], ['copysignf', '<math.h>'], ['copysignl', '<math.h>'],
  ['fmax', '<math.h>'], ['fmaxf', '<math.h>'], ['fmaxl', '<math.h>'],
  ['fmin', '<math.h>'], ['fminf', '<math.h>'], ['fminl', '<math.h>'],
  ['fdim', '<math.h>'], ['fdimf', '<math.h>'], ['fdiml', '<math.h>'],
  ['fma', '<math.h>'], ['fmaf', '<math.h>'], ['fmal', '<math.h>'],
  ['sin', '<math.h>'], ['sinf', '<math.h>'], ['sinl', '<math.h>'],
  ['cos', '<math.h>'], ['cosf', '<math.h>'], ['cosl', '<math.h>'],
  ['tan', '<math.h>'], ['tanf', '<math.h>'], ['tanl', '<math.h>'],
  ['asin', '<math.h>'], ['asinf', '<math.h>'], ['asinl', '<math.h>'],
  ['acos', '<math.h>'], ['acosf', '<math.h>'], ['acosl', '<math.h>'],
  ['atan', '<math.h>'], ['atanf', '<math.h>'], ['atanl', '<math.h>'],
  ['atan2', '<math.h>'], ['atan2f', '<math.h>'], ['atan2l', '<math.h>'],
  ['sinh', '<math.h>'], ['sinhf', '<math.h>'], ['sinhl', '<math.h>'],
  ['cosh', '<math.h>'], ['coshf', '<math.h>'], ['coshl', '<math.h>'],
  ['tanh', '<math.h>'], ['tanhf', '<math.h>'], ['tanhl', '<math.h>'],
  ['asinh', '<math.h>'], ['asinhf', '<math.h>'], ['asinhl', '<math.h>'],
  ['acosh', '<math.h>'], ['acoshf', '<math.h>'], ['acoshl', '<math.h>'],
  ['atanh', '<math.h>'], ['atanhf', '<math.h>'], ['atanhl', '<math.h>'],
  ['exp', '<math.h>'], ['expf', '<math.h>'], ['expl', '<math.h>'],
  ['exp2', '<math.h>'], ['exp2f', '<math.h>'], ['exp2l', '<math.h>'],
  ['expm1', '<math.h>'], ['expm1f', '<math.h>'], ['expm1l', '<math.h>'],
  ['log', '<math.h>'], ['logf', '<math.h>'], ['logl', '<math.h>'],
  ['log10', '<math.h>'], ['log10f', '<math.h>'], ['log10l', '<math.h>'],
  ['log2', '<math.h>'], ['log2f', '<math.h>'], ['log2l', '<math.h>'],
  ['log1p', '<math.h>'], ['log1pf', '<math.h>'], ['log1pl', '<math.h>'],
  ['ldexp', '<math.h>'], ['ldexpf', '<math.h>'], ['ldexpl', '<math.h>'],
  ['frexp', '<math.h>'], ['frexpf', '<math.h>'], ['frexpl', '<math.h>'],
  ['scalbn', '<math.h>'], ['scalbnf', '<math.h>'], ['scalbnl', '<math.h>'],
  ['ilogb', '<math.h>'], ['ilogbf', '<math.h>'], ['ilogbl', '<math.h>'],
  ['logb', '<math.h>'], ['logbf', '<math.h>'], ['logbl', '<math.h>'],
  ['erf', '<math.h>'], ['erff', '<math.h>'], ['erfl', '<math.h>'],
  ['erfc', '<math.h>'], ['erfcf', '<math.h>'], ['erfcl', '<math.h>'],
  ['tgamma', '<math.h>'], ['tgammaf', '<math.h>'], ['tgammal', '<math.h>'],
  ['lgamma', '<math.h>'], ['lgammaf', '<math.h>'], ['lgammal', '<math.h>'],
  ['nan', '<math.h>'], ['nanf', '<math.h>'], ['nanl', '<math.h>'],
  ['nextafter', '<math.h>'], ['nextafterf', '<math.h>'], ['nextafterl', '<math.h>'],
  // <ctype.h>
  ['isalpha', '<ctype.h>'], ['isdigit', '<ctype.h>'], ['isalnum', '<ctype.h>'],
  ['isspace', '<ctype.h>'], ['isupper', '<ctype.h>'], ['islower', '<ctype.h>'],
  ['isxdigit', '<ctype.h>'], ['ispunct', '<ctype.h>'], ['isprint', '<ctype.h>'],
  ['isgraph', '<ctype.h>'], ['iscntrl', '<ctype.h>'], ['isblank', '<ctype.h>'],
  ['tolower', '<ctype.h>'], ['toupper', '<ctype.h>'],
  ['isascii', '<ctype.h>'], ['toascii', '<ctype.h>'],
]));

const STANDARD_C_HEADER_SET = new Set(STANDARD_C_LIBRARY_HEADERS.values());

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

export function isStandalonePrototypePreludeComment(text) {
  return String(text ?? '').trim() === STANDALONE_PROTOTYPES_COMMENT;
}

export function isStandalonePrototypePreludeDeclaration(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '#ifndef __HEX_ANY_ARGS'
    || trimmed === '#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 202311L'
    || trimmed === '#define __HEX_ANY_ARGS ...'
    || trimmed === '#else'
    || trimmed === '#define __HEX_ANY_ARGS'
    || trimmed === '#endif') return true;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\((?:\s*|\s*__HEX_ANY_ARGS\s*|\s*uint64\s*,\s*\.\.\.\s*|\s*\.\.\.\s*)\)\s*;$/.exec(trimmed);
  return !!match && FIXED_WIDTH_TYPES.has(match[1]) && !KEYWORDS.has(match[2]);
}

export function isIdTypedefPreludeDeclaration(text) {
  return String(text ?? '').trim() === 'typedef void * id;';
}

export function parseStandardHeaderInclude(text) {
  const match = /^#include\s*(<[A-Za-z0-9_./+-]+>)$/.exec(String(text ?? '').trim());
  return match && STANDARD_C_HEADER_SET.has(match[1]) ? match[1] : null;
}

export function isStandardHeaderInclude(text) {
  return parseStandardHeaderInclude(text) !== null;
}

export function isBitfieldHelperPreludeComment(text) {
  return String(text ?? '').trim() === BITFIELD_HELPERS_COMMENT;
}

export function parseBitfieldHelperDefinition(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === BIT_EXTRACT_HELPER_DEF) return 'bit_extract';
  if (trimmed === BIT_INSERT_HELPER_DEF) return 'bit_insert';
  return null;
}

export function isBitfieldHelperPreludeDeclaration(text) {
  const trimmed = String(text ?? '').trim();
  return trimmed === '#ifndef __hex_bit_extract_defined'
    || trimmed === '#define __hex_bit_extract_defined'
    || trimmed === '#ifndef __hex_bit_insert_defined'
    || trimmed === '#define __hex_bit_insert_defined'
    || parseBitfieldHelperDefinition(trimmed) !== null;
}

export function bitfieldHelperBlockText(name) {
  if (name === 'bit_extract') {
    return [
      '#ifndef __hex_bit_extract_defined',
      '#define __hex_bit_extract_defined',
      BIT_EXTRACT_HELPER_DEF,
      '#endif',
    ].join('\n');
  }
  if (name === 'bit_insert') {
    return [
      '#ifndef __hex_bit_insert_defined',
      '#define __hex_bit_insert_defined',
      BIT_INSERT_HELPER_DEF,
      '#endif',
    ].join('\n');
  }
  return null;
}

/* Remove comments and literals so identifier scans never read prose or asm
 * text.  Newlines are preserved so callers can still reason about lines. */
export function declarationBearingSource(text) {
  const source = String(text ?? '');
  let out = '';
  let state = 'code';
  let lineStart = true;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (lineStart && ch === '#') { out += ' '; state = 'preproc'; lineStart = false; continue; }
      if (ch === '/' && next === '/') { out += '  '; i++; state = 'line'; lineStart = false; continue; }
      if (ch === '/' && next === '*') { out += '  '; i++; state = 'block'; continue; }
      if (ch === '"') { out += ' '; state = 'string'; lineStart = false; continue; }
      if (ch === "'") { out += ' '; state = 'char'; lineStart = false; continue; }
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
        lineStart = false;
        continue;
      }
      if (ch === '\n') lineStart = true;
      else if (ch !== ' ' && ch !== '\t' && ch !== '\r') lineStart = false;
      out += ch;
      continue;
    }
    if (state === 'preproc') {
      if (ch === '\\' && next === '\n') { out += ' \n'; i++; continue; }
      if (ch === '\\' && next === '\r' && source[i + 2] === '\n') { out += '  \n'; i += 2; continue; }
      if (ch === '\n') { out += '\n'; state = 'code'; lineStart = true; }
      else out += ' ';
      continue;
    }
    if (state === 'line') { if (ch === '\n') { out += '\n'; state = 'code'; lineStart = true; } else out += ' '; continue; }
    if (state === 'block') {
      if (ch === '*' && next === '/') { out += '  '; i++; state = 'code'; }
      else if (ch === '\n') { out += '\n'; lineStart = true; }
      else out += ' ';
      continue;
    }
    if (ch === '\\') {
      if (next === '\n') { out += ' \n'; i++; }
      else if (next === '\r' && source[i + 2] === '\n') { out += '  \n'; i += 2; }
      else if (i + 1 < source.length) { out += '  '; i++; }
      else out += ' ';
      continue;
    }
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
function findMatchingDelimiter(source, openIdx, openCh, closeCh) {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === openCh) depth++;
    else if (source[i] === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const OBJC_EXPR_START_KEYWORDS = new Set(['return', 'case', 'else', 'do']);

/*
 * Identify ObjC selector token offsets inside balanced `[receiver sel]` and
 * `[receiver part0:arg0 part1:arg1]` message sends in declaration-bearing
 * source.  C array subscripts `ident[idx]` are excluded.
 */
function collectObjcSelectorOffsets(source) {
  const offsets = new Set();
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '[') continue;
    const before = previousChar(source, i);
    if (before === "]" || (/[A-Za-z0-9_]/.test(before) && !OBJC_EXPR_START_KEYWORDS.has(previousWord(source, i)))) continue;
    const closeIdx = findMatchingDelimiter(source, i, '[', ']');
    if (closeIdx < 0) continue;

    // Advance past receiver expression.
    let p = i + 1;
    while (p < closeIdx && /\s/.test(source[p])) p++;
    if (p >= closeIdx) continue;
    while (p < closeIdx && (source[p] === '*' || source[p] === '&' || source[p] === '@' || source[p] === '!' || source[p] === '~')) {
      p++;
      while (p < closeIdx && /\s/.test(source[p])) p++;
    }
    if (p >= closeIdx) continue;
    if (source[p] === '[') {
      const m = findMatchingDelimiter(source, p, '[', ']');
      if (m < 0 || m >= closeIdx) continue;
      p = m + 1;
    } else if (source[p] === '(') {
      const m = findMatchingDelimiter(source, p, '(', ')');
      if (m < 0 || m >= closeIdx) continue;
      p = m + 1;
    } else if (/[A-Za-z_]/.test(source[p])) {
      while (p < closeIdx && /[A-Za-z0-9_]/.test(source[p])) p++;
    } else {
      continue;
    }
    // Consume tightly attached postfix operators on the receiver (arr[0], p->x, s.x, fn()).
    while (p < closeIdx) {
      if (source[p] === '[') {
        const m = findMatchingDelimiter(source, p, '[', ']');
        if (m < 0 || m >= closeIdx) break;
        p = m + 1;
      } else if (source[p] === '(') {
        const m = findMatchingDelimiter(source, p, '(', ')');
        if (m < 0 || m >= closeIdx) break;
        p = m + 1;
      } else if (source[p] === '.') {
        p++;
        while (p < closeIdx && /\s/.test(source[p])) p++;
        while (p < closeIdx && /[A-Za-z0-9_]/.test(source[p])) p++;
      } else if (source[p] === '-' && source[p + 1] === '>') {
        p += 2;
        while (p < closeIdx && /\s/.test(source[p])) p++;
        while (p < closeIdx && /[A-Za-z0-9_]/.test(source[p])) p++;
      } else {
        break;
      }
    }

    let afterRecv = p;
    while (afterRecv < closeIdx && /\s/.test(source[afterRecv])) afterRecv++;
    if (afterRecv === p || afterRecv >= closeIdx) continue;

    // Case 1: 0-arg selector `[receiver sel]` where a single identifier sits before `]`.
    if (/[A-Za-z_]/.test(source[afterRecv])) {
      let idEnd = afterRecv;
      while (idEnd < closeIdx && /[A-Za-z0-9_]/.test(source[idEnd])) idEnd++;
      let tail = idEnd;
      while (tail < closeIdx && /\s/.test(source[tail])) tail++;
      if (tail === closeIdx) {
        offsets.add(afterRecv);
        continue;
      }
    }

    // Case 2: multi-arg selector `[receiver part0:arg0 part1:arg1]`.
    let parenDepth = 0;
    let bracketDepth = 0;
    let ternaryDepth = 0;
    let cur = afterRecv;
    while (cur < closeIdx) {
      const ch = source[cur];
      if (ch === '(') { parenDepth++; cur++; continue; }
      if (ch === ')') { if (parenDepth > 0) parenDepth--; cur++; continue; }
      if (ch === '[') { bracketDepth++; cur++; continue; }
      if (ch === ']') { if (bracketDepth > 0) bracketDepth--; cur++; continue; }
      if (parenDepth === 0 && bracketDepth === 0) {
        if (ch === '?') { ternaryDepth++; cur++; continue; }
        if (ch === ':') { if (ternaryDepth > 0) ternaryDepth--; cur++; continue; }
        if (/[A-Za-z_]/.test(ch)) {
          const tokStart = cur;
          while (cur < closeIdx && /[A-Za-z0-9_]/.test(source[cur])) cur++;
          let look = cur;
          while (look < closeIdx && /\s/.test(source[look])) look++;
          if (look < closeIdx && source[look] === ':' && ternaryDepth === 0) {
            offsets.add(tokStart);
          }
          continue;
        }
      }
      cur++;
    }
  }
  return offsets;
}

export function scanIdentifierUses(text) {
  const source = declarationBearingSource(text);
  const objcSelectorOffsets = collectObjcSelectorOffsets(source);
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
    const objcSelector = objcSelectorOffsets.has(start);
    const label = !objcSelector && after === ':' && startsStatement(source, start);
    const gotoLabel = previousWord(source, start) === 'goto';
    const isNonPointerCast = (() => {
      if (before !== '(' || after !== ')') return false;
      if (registerType(name) != null || /^(?:var|local|tmp|call|load|arg)_/.test(name)) return false;
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
    const isValueUse = !callTarget && !memberName && !label && !gotoLabel && !castType && !tag && !objcSelector;
    const subscriptBase = isValueUse && after === '[';
    const entry = uses.get(name) ?? {
      name, firstIndex: start, callTarget: false, callTargetOnly: true, memberName: false,
      memberBase: false, label: false, gotoLabel: false, castType: false, tag: false,
      objcSelector: false, subscriptBase: false, nonSubscriptValue: false, value: false,
    };
    entry.callTarget ||= callTarget;
    if (!callTarget) entry.callTargetOnly = false;
    entry.memberName ||= memberName;
    entry.memberBase ||= memberBase;
    entry.label ||= label || gotoLabel;
    entry.castType ||= castType;
    entry.tag ||= tag;
    entry.objcSelector ||= objcSelector;
    entry.subscriptBase ||= subscriptBase;
    if (isValueUse) {
      entry.value = true;
      if (!subscriptBase) entry.nonSubscriptValue = true;
    }
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

const C_PRIMITIVE_TYPE_KEYWORDS = new Set([
  'void', 'char', 'short', 'int', 'long', 'float', 'double', '_Bool', 'bool', '__int128',
]);

function splitTopLevelCommas(text) {
  const parts = [];
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') paren++;
    else if (ch === ')') { if (paren > 0) paren--; }
    else if (ch === '[') bracket++;
    else if (ch === ']') { if (bracket > 0) bracket--; }
    else if (ch === '{') brace++;
    else if (ch === '}') { if (brace > 0) brace--; }
    else if (ch === ',' && paren === 0 && bracket === 0 && brace === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function cutBeforeTopLevelAssign(text) {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') paren++;
    else if (ch === ')') { if (paren > 0) paren--; }
    else if (ch === '[') bracket++;
    else if (ch === ']') { if (bracket > 0) bracket--; }
    else if (ch === '{') brace++;
    else if (ch === '}') { if (brace > 0) brace--; }
    else if (ch === '=' && paren === 0 && bracket === 0 && brace === 0 && text[i + 1] !== '=' && text[i - 1] !== '!' && text[i - 1] !== '<' && text[i - 1] !== '>') {
      return text.slice(0, i);
    }
  }
  return text;
}

function extractDeclaredNamesFromDeclText(cleaned, outSet) {
  const trimmed = cleaned.trim().replace(/;\s*$/, '').trim();
  if (!trimmed) return;
  if (/^typedef\b/.test(trimmed)) {
    const aliasMatch = /\b([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
    if (aliasMatch && !KEYWORDS.has(aliasMatch[1])) outSet.add(aliasMatch[1]);
    const tagMatch = /\b(?:struct|union|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(trimmed);
    if (tagMatch && !KEYWORDS.has(tagMatch[1])) outSet.add(tagMatch[1]);
    return;
  }
  const beforeAssign = cutBeforeTopLevelAssign(trimmed).trim();
  const openParen = beforeAssign.indexOf('(');
  if (openParen >= 0) {
    const fnPtrMatch = /\(\s*\*+\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/.exec(beforeAssign);
    if (fnPtrMatch && !KEYWORDS.has(fnPtrMatch[1])) {
      outSet.add(fnPtrMatch[1]);
      return;
    }
    const beforeParen = beforeAssign.slice(0, openParen).trim();
    const fnNameMatch = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(beforeParen);
    if (fnNameMatch && !KEYWORDS.has(fnNameMatch[1])) outSet.add(fnNameMatch[1]);
    return;
  }
  const declarators = splitTopLevelCommas(trimmed);
  for (let idx = 0; idx < declarators.length; idx++) {
    const head = cutBeforeTopLevelAssign(declarators[idx]).replace(/\[[^\]]*\]/g, '').trim();
    const tokens = [...head.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => m[0]);
    const name = tokens.at(-1);
    if (name && !KEYWORDS.has(name)) outSet.add(name);
    if (idx === 0 && tokens.length >= 2) {
      for (let t = 0; t < tokens.length - 1; t++) {
        const tok = tokens[t];
        if (!KEYWORDS.has(tok) && !/^(?:struct|union|enum)$/.test(tokens[t - 1] || '')) outSet.add(tok);
      }
    }
  }
}

/* Names a declaration line, stmt-kind local declaration, or prelude typedef line introduces. */
function declaredNamesFromLines(lines) {
  const declared = new Set();
  const definedTypes = definedTypeAliases(lines);
  let braceDepth = 0;
  for (const item of lines || []) {
    const cleanedRaw = declarationBearingSource(item?.text ?? '');
    if (item?.kind === 'decl') {
      extractDeclaredNamesFromDeclText(cleanedRaw, declared);
    } else if (item?.kind === 'stmt') {
      const cleaned = cleanedRaw.trim();
      if (/^typedef\b/.test(cleaned)) {
        const aliasMatch = /\b([A-Za-z_][A-Za-z0-9_]*)\s*;$/.exec(cleaned);
        if (aliasMatch && !KEYWORDS.has(aliasMatch[1])) declared.add(aliasMatch[1]);
        const tagMatch = /\b(?:struct|union|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(cleaned);
        if (tagMatch && !KEYWORDS.has(tagMatch[1])) declared.add(tagMatch[1]);
      } else if (braceDepth <= 1) {
        const match = /^((?:(?:const|volatile|static|extern|register|unsigned|signed|short|long|struct|union|enum)\s+)*)([A-Za-z_][A-Za-z0-9_]*)(\s+(?:\*+\s*)*|\s*\*+\s*)([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|;|\[|,)/.exec(cleaned);
        if (match && !NON_DECL_STMT_HEADS.has(match[2]) && !KEYWORDS.has(match[4])) {
          const hasQualifier = match[1].trim().length > 0;
          const typeTok = match[2];
          const hasStar = match[3].includes('*');
          const knownType = FIXED_WIDTH_TYPES.has(typeTok)
            || STANDARD_KNOWN_TYPES.has(typeTok)
            || C_PRIMITIVE_TYPE_KEYWORDS.has(typeTok)
            || typeTok === 'id'
            || /^hex_struct_/.test(typeTok)
            || definedTypes.has(typeTok);
          if (!hasStar || hasQualifier || knownType) {
            if (!/\b(?:struct|union|enum)\s+$/.test(match[1])) declared.add(typeTok);
            for (const part of splitTopLevelCommas(cleaned.replace(/;\s*$/, ''))) {
              const head = cutBeforeTopLevelAssign(part).replace(/\[[^\]]*\]/g, '').trim();
              const nm = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(head);
              if (nm && !KEYWORDS.has(nm[1])) declared.add(nm[1]);
            }
          }
        }
      }
    }
    for (const ch of cleanedRaw) {
      if (ch === '{') braceDepth++;
      else if (ch === '}' && braceDepth > 0) braceDepth--;
    }
  }
  return declared;
}

const STANDARD_KNOWN_TYPES = new Set([
  'size_t', 'ssize_t', 'ptrdiff_t', 'uintptr_t', 'intptr_t', 'wchar_t', 'va_list', 'FILE',
]);

/* Extract pointer parameter bindings (`Thing * this`, `const Base * a2`) from a function signature. */
function signaturePointerParams(signature) {
  const result = [];
  const text = declarationBearingSource(signature);
  const open = text.indexOf('(');
  if (open < 0) return result;
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') { depth--; if (!depth) { close = i; break; } }
  }
  if (close <= open) return result;
  for (const rawGroup of text.slice(open + 1, close).split(',')) {
    const group = rawGroup.trim();
    if (!group || group === 'void' || !group.includes('*')) continue;
    const match = /^(?:(?:const|volatile|restrict|struct|union|enum)\s+)*([A-Za-z_][A-Za-z0-9_]*)\s*(?:const\s+|volatile\s+|restrict\s+)*\*+\s*(?:const\s+|volatile\s+|restrict\s+)*([A-Za-z_][A-Za-z0-9_]*)$/.exec(group);
    if (!match) continue;
    const typeName = match[1];
    const paramName = match[2];
    if (KEYWORDS.has(typeName) || FIXED_WIDTH_TYPES.has(typeName) || STANDARD_KNOWN_TYPES.has(typeName)) continue;
    result.push({ typeName, paramName });
  }
  return result;
}

function atomicCompatPreludeLines(uses, existingLines, entrySource) {
  const out = [];
  const hasMacro = (name) => (existingLines || []).some((l) => String(l?.text ?? '').includes(`#define ${name}(`));
  if (uses.get('__atomic_load')?.callTarget && !hasMacro('__atomic_load')) {
    out.push(
      { kind: 'decl', indent: 0, text: '#ifndef __hex_atomic_load_defined', row: null, addr: null, note: null, source: entrySource },
      { kind: 'decl', indent: 0, text: '#define __hex_atomic_load_defined', row: null, addr: null, note: null, source: entrySource },
      { kind: 'decl', indent: 0, text: '#define __atomic_load(ptr) __atomic_load_n((ptr), __ATOMIC_SEQ_CST)', row: null, addr: null, note: null, source: entrySource },
      { kind: 'decl', indent: 0, text: '#endif', row: null, addr: null, note: null, source: entrySource },
    );
  }
  if (uses.get('__atomic_store')?.callTarget && !hasMacro('__atomic_store')) {
    out.push(
      { kind: 'decl', indent: 0, text: '#ifndef __hex_atomic_store_defined', row: null, addr: null, note: null, source: entrySource },
      { kind: 'decl', indent: 0, text: '#define __hex_atomic_store_defined', row: null, addr: null, note: null, source: entrySource },
      { kind: 'decl', indent: 0, text: '#define __atomic_store(ptr, val) (__atomic_store_n((ptr), (val), __ATOMIC_SEQ_CST), 0)', row: null, addr: null, note: null, source: entrySource },
      { kind: 'decl', indent: 0, text: '#endif', row: null, addr: null, note: null, source: entrySource },
    );
  }
  return out;
}



function bitfieldHelperPreludeLines(uses, existingLines, entrySource) {
  const out = [];
  const hasHelper = (macroName, fnName) => (existingLines || []).some((l) => {
    const t = String(l?.text ?? '');
    return t.includes(`#define ${macroName}`) || t.includes(`static inline uint64 ${fnName}(`);
  });
  const needExtract = uses.get('bit_extract')?.callTarget && !hasHelper('__hex_bit_extract_defined', 'bit_extract');
  const needInsert = uses.get('bit_insert')?.callTarget && !hasHelper('__hex_bit_insert_defined', 'bit_insert');
  if (needExtract || needInsert) {
    out.push({ kind: 'decl', indent: 0, text: BITFIELD_HELPERS_COMMENT, row: null, addr: null, note: null, source: entrySource });
  }
  if (needExtract) {
    out.push(
      { kind: 'decl', indent: 0, text: '#ifndef __hex_bit_extract_defined', row: null, addr: null, note: null, source: entrySource },
      { kind: 'decl', indent: 0, text: '#define __hex_bit_extract_defined', row: null, addr: null, note: null, source: entrySource },
      { kind: 'decl', indent: 0, text: BIT_EXTRACT_HELPER_DEF, row: null, addr: null, note: null, source: entrySource },
      { kind: 'decl', indent: 0, text: '#endif', row: null, addr: null, note: null, source: entrySource },
    );
  }
  if (needInsert) {
    out.push(
      { kind: 'decl', indent: 0, text: '#ifndef __hex_bit_insert_defined', row: null, addr: null, note: null, source: entrySource },
      { kind: 'decl', indent: 0, text: '#define __hex_bit_insert_defined', row: null, addr: null, note: null, source: entrySource },
      { kind: 'decl', indent: 0, text: BIT_INSERT_HELPER_DEF, row: null, addr: null, note: null, source: entrySource },
      { kind: 'decl', indent: 0, text: '#endif', row: null, addr: null, note: null, source: entrySource },
    );
  }
  return out;
}

function callSiteArityRange(source, name) {
  const re = new RegExp('\\b' + escapeRegExp(name) + '\\s*\\(', 'g');
  let minArgs = Infinity;
  let maxArgs = 0;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let i = m.index + m[0].length;
    let depth = 1;
    let commas = 0;
    let hasNonSpace = false;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) break; }
      else if (ch === ',' && depth === 1) commas++;
      else if (!/\s/.test(ch) && depth === 1) hasNonSpace = true;
      i++;
    }
    const argc = hasNonSpace ? commas + 1 : 0;
    if (argc < minArgs) minArgs = argc;
    if (argc > maxArgs) maxArgs = argc;
  }
  return minArgs === Infinity ? { minArgs: 0, maxArgs: 0 } : { minArgs, maxArgs };
}

function signatureFunctionName(signature) {
  const text = declarationBearingSource(signature);
  const open = text.indexOf('(');
  if (open < 0) return null;
  const tokens = [...text.slice(0, open).matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => m[0]);
  return tokens.length ? tokens[tokens.length - 1] : null;
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
export 
function inferPointerTypedLocals(renderedBody, sigText) {
  const source = declarationBearingSource(renderedBody);
  const sigPtrNames = new Set(signaturePointerParams(sigText).map((item) => item.paramName));
  const ptrParamRe = /(?:\bid\s+|\*\s*)([A-Za-z_][A-Za-z0-9_]*)\s*(?=[,)])/g;
  const cleanSig = declarationBearingSource(sigText);
  for (let m = ptrParamRe.exec(cleanSig); m; m = ptrParamRe.exec(cleanSig)) {
    sigPtrNames.add(m[1]);
  }
  const rawText = String(renderedBody ?? '');
  const assignPattern = /(?:^|(?<=[;{}]))\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?!=)([^;{}]+);/gm;
  const stats = new Map();
  const isStringOrPtrExpr = (expr) => {
    const t = expr.trim();
    if (!t) return false;
    if (sigPtrNames.has(t)) return true;
    if (/^"(?:[^"\\]|\\.)*"$/.test(t)) return true;
    if (/^&\s*[A-Za-z_][A-Za-z0-9_]*$/.test(t)) return true;
    if (/^\([^()]*\*\s*\)/.test(t)) return true;
    const tern = /^[^?]+\?\s*([^:]+)\s*:\s*(.+)$/.exec(t);
    if (tern && isStringOrPtrExpr(tern[1]) && isStringOrPtrExpr(tern[2])) return true;
    return false;
  };
  for (let m = assignPattern.exec(rawText); m; m = assignPattern.exec(rawText)) {
    const lhs = m[1];
    const rhs = m[2].trim();
    if (/^\s*(?:return|if|while|for|switch|typedef|extern)\b/.test(lhs)) continue;
    let st = stats.get(lhs);
    if (!st) { st = { ptrAssigns: 0, nonPtrAssigns: 0 }; stats.set(lhs, st); }
    if (isStringOrPtrExpr(rhs)) st.ptrAssigns++;
    else st.nonPtrAssigns++;
  }
  const ptrLocals = new Set();
  for (const [name, st] of stats.entries()) {
    if (st.ptrAssigns > 0 && st.nonPtrAssigns === 0) {
      const arithRe = new RegExp('\\b' + escapeRegExp(name) + '\\b\\s*(?:[+*&|^%/-]|<<|>>|\\[)|(?:[+*&|^%/-]|<<|>>)\\s*\\b' + escapeRegExp(name) + '\\b');
      if (!arithRe.test(source)) ptrLocals.add(name);
    }
  }
  return ptrLocals;
}

function inferMutablePtrReturnLocals(renderedBody) {
  const source = declarationBearingSource(renderedBody);
  const assignPattern = /(?:^|(?<=[;{}]))\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?!=)([^;{}]+);/gm;
  const stats = new Map();
  const isPtrRetCall = (expr) => {
    const t = stripOuterParens(expr);
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(t);
    if (!m || !t.endsWith(')') || !STDLIB_PTR_RETURN_FUNCTIONS.has(m[1])) return false;
    const openIdx = t.indexOf('(', m[1].length);
    return openIdx >= 0 && findMatchingDelimRaw(t, openIdx, '(', ')') === t.length - 1;
  };
  for (let m = assignPattern.exec(source); m; m = assignPattern.exec(source)) {
    const lhs = m[1];
    const rhs = m[2].trim();
    if (/^\s*(?:return|if|while|for|switch|typedef|extern)\b/.test(lhs)) continue;
    let st = stats.get(lhs);
    if (!st) { st = { ptrRetAssigns: 0, otherAssigns: 0 }; stats.set(lhs, st); }
    if (isPtrRetCall(rhs)) st.ptrRetAssigns++;
    else st.otherAssigns++;
  }
  const candidates = new Set();
  for (const [name, st] of stats.entries()) {
    if (st.ptrRetAssigns > 0 && st.otherAssigns === 0) {
      const esc = escapeRegExp(name);
      const badOpRe = new RegExp('\\b' + esc + '\\b\\s*(?:\\+=|[*&|^%/-]|<<|>>|\\[)|(?:[*&|^%/-]|<<|>>)\\s*\\b' + esc + '\\b');
      if (!badOpRe.test(source)) candidates.add(name);
    }
  }
  // Reject pointer+pointer additions (e.g. p + q), which are hard C errors on void */char *
  for (const name of [...candidates]) {
    const esc = escapeRegExp(name);
    const addRe = new RegExp('\\b' + esc + '\\b\\s*\\+\\s*(?:\\([^)]*\\)\\s*)?([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*)\\s*\\+\\s*(?:\\([^)]*\\)\\s*)?\\b' + esc + '\\b', 'g');
    let hasPtrPtr = false;
    for (let m = addRe.exec(source); m; m = addRe.exec(source)) {
      const other = m[1] || m[2];
      if (other && (other === name || candidates.has(other))) { hasPtrPtr = true; break; }
    }
    if (hasPtrPtr) candidates.delete(name);
  }
  const result = new Map();
  for (const name of candidates) {
    const esc = escapeRegExp(name);
    const plusRe = new RegExp('\\b' + esc + '\\b\\s*\\+|\\+\\s*\\b' + esc + '\\b');
    result.set(name, plusRe.test(source) ? 'char *' : 'void *');
  }
  return result;
}

function localDeclarationTypeFor(name, result) {
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

function isDeclarableLocal(entry, declared, declaredMemberBases = null) {
  const name = entry?.name;
  if (!name || !entry.value || declared.has(name)) return false;
  if (KEYWORDS.has(name) || FIXED_WIDTH_TYPES.has(name) || name === 'id' || name === '__HEX_ANY_ARGS') return false;
  const handledAsMemberBase = declaredMemberBases ? declaredMemberBases.has(name) : entry.memberBase;
  if (entry.callTarget || handledAsMemberBase || entry.castType) return false;
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


const STDLIB_PTR_RETURN_FUNCTIONS = Object.freeze(new Set([
  // <stdlib.h>
  'malloc', 'calloc', 'realloc', 'aligned_alloc', 'bsearch', 'getenv',
  // <string.h>
  'strcpy', 'strncpy', 'strcat', 'strncat', 'strdup', 'strndup',
  'strchr', 'strrchr', 'strstr', 'strpbrk', 'strtok', 'strtok_r', 'strerror',
  'memcpy', 'memmove', 'memset', 'memchr',
  // <strings.h>
  'index', 'rindex',
  // <stdio.h>
  'fgets', 'fopen', 'freopen', 'tmpfile', 'tmpnam',
]));

const LP64_SIZE_T_BUILTIN_PTR_ARGS = Object.freeze({
  // <stdlib.h>
  realloc: { 0: 'void *' },
  free: { 0: 'void *' },
  strtol: { 0: 'const char *', 1: 'char **' },
  strtoul: { 0: 'const char *', 1: 'char **' },
  strtoll: { 0: 'const char *', 1: 'char **' },
  strtoull: { 0: 'const char *', 1: 'char **' },
  strtod: { 0: 'const char *', 1: 'char **' },
  strtof: { 0: 'const char *', 1: 'char **' },
  strtold: { 0: 'const char *', 1: 'char **' },
  atoi: { 0: 'const char *' },
  atol: { 0: 'const char *' },
  atoll: { 0: 'const char *' },
  atof: { 0: 'const char *' },
  qsort: { 0: 'void *', 3: 'int (*)(const void *, const void *)' },
  bsearch: { 0: 'const void *', 1: 'const void *', 4: 'int (*)(const void *, const void *)' },
  atexit: { 0: 'void (*)(void)' },
  system: { 0: 'const char *' },
  getenv: { 0: 'const char *' },
  mblen: { 0: 'const char *' },
  mbtowc: { 0: 'void *', 1: 'const char *' },
  wctomb: { 0: 'char *' },
  mbstowcs: { 0: 'void *', 1: 'const char *' },
  wcstombs: { 0: 'char *', 1: 'const void *' },
  // <string.h>
  strlen: { 0: 'const char *' },
  strnlen: { 0: 'const char *' },
  strcpy: { 0: 'char *', 1: 'const char *' },
  strncpy: { 0: 'char *', 1: 'const char *' },
  strcat: { 0: 'char *', 1: 'const char *' },
  strncat: { 0: 'char *', 1: 'const char *' },
  strdup: { 0: 'const char *' },
  strndup: { 0: 'const char *' },
  strcmp: { 0: 'const char *', 1: 'const char *' },
  strncmp: { 0: 'const char *', 1: 'const char *' },
  strcoll: { 0: 'const char *', 1: 'const char *' },
  strxfrm: { 0: 'char *', 1: 'const char *' },
  strchr: { 0: 'const char *' },
  strrchr: { 0: 'const char *' },
  strstr: { 0: 'const char *', 1: 'const char *' },
  strpbrk: { 0: 'const char *', 1: 'const char *' },
  strspn: { 0: 'const char *', 1: 'const char *' },
  strcspn: { 0: 'const char *', 1: 'const char *' },
  strtok: { 0: 'char *', 1: 'const char *' },
  strtok_r: { 0: 'char *', 1: 'const char *', 2: 'char **' },
  memcpy: { 0: 'void *', 1: 'const void *' },
  memmove: { 0: 'void *', 1: 'const void *' },
  memset: { 0: 'void *' },
  memcmp: { 0: 'const void *', 1: 'const void *' },
  memchr: { 0: 'const void *' },
  // <strings.h>
  strcasecmp: { 0: 'const char *', 1: 'const char *' },
  strncasecmp: { 0: 'const char *', 1: 'const char *' },
  bzero: { 0: 'void *' },
  bcopy: { 0: 'const void *', 1: 'void *' },
  bcmp: { 0: 'const void *', 1: 'const void *' },
  index: { 0: 'const char *' },
  rindex: { 0: 'const char *' },
  // <stdio.h>
  printf: { 0: 'const char *' },
  fprintf: { 0: 'void *', 1: 'const char *' },
  sprintf: { 0: 'char *', 1: 'const char *' },
  snprintf: { 0: 'char *', 2: 'const char *' },
  vprintf: { 0: 'const char *' },
  vfprintf: { 0: 'void *', 1: 'const char *' },
  vsprintf: { 0: 'char *', 1: 'const char *' },
  vsnprintf: { 0: 'char *', 2: 'const char *' },
  scanf: { 0: 'const char *' },
  fscanf: { 0: 'void *', 1: 'const char *' },
  sscanf: { 0: 'const char *', 1: 'const char *' },
  vscanf: { 0: 'const char *' },
  vfscanf: { 0: 'void *', 1: 'const char *' },
  vsscanf: { 0: 'const char *', 1: 'const char *' },
  puts: { 0: 'const char *' },
  fputs: { 0: 'const char *', 1: 'void *' },
  putc: { 1: 'void *' },
  fputc: { 1: 'void *' },
  getc: { 0: 'void *' },
  fgetc: { 0: 'void *' },
  ungetc: { 1: 'void *' },
  fgets: { 0: 'char *', 2: 'void *' },
  getline: { 0: 'char **', 1: 'size_t *', 2: 'void *' },
  fopen: { 0: 'const char *', 1: 'const char *' },
  freopen: { 0: 'const char *', 1: 'const char *', 2: 'void *' },
  fclose: { 0: 'void *' },
  fflush: { 0: 'void *' },
  fread: { 0: 'void *', 3: 'void *' },
  fwrite: { 0: 'const void *', 3: 'void *' },
  fseek: { 0: 'void *' },
  ftell: { 0: 'void *' },
  rewind: { 0: 'void *' },
  fgetpos: { 0: 'void *', 1: 'void *' },
  fsetpos: { 0: 'void *', 1: 'const void *' },
  feof: { 0: 'void *' },
  ferror: { 0: 'void *' },
  clearerr: { 0: 'void *' },
  perror: { 0: 'const char *' },
  remove: { 0: 'const char *' },
  rename: { 0: 'const char *', 1: 'const char *' },
  tmpnam: { 0: 'char *' },
  setbuf: { 0: 'void *', 1: 'char *' },
  setvbuf: { 0: 'void *', 1: 'char *' },
  fileno: { 0: 'void *' },
  // <math.h>
  remquo: { 2: 'int *' },
  remquof: { 2: 'int *' },
  remquol: { 2: 'int *' },
  modf: { 1: 'double *' },
  modff: { 1: 'float *' },
  modfl: { 1: 'long double *' },
  frexp: { 1: 'int *' },
  frexpf: { 1: 'int *' },
  frexpl: { 1: 'int *' },
  nan: { 0: 'const char *' },
  nanf: { 0: 'const char *' },
  nanl: { 0: 'const char *' },
  // <wchar.h> / <time.h>
  wcslen: { 0: 'const void *' },
  strftime: { 0: 'char *', 2: 'const char *', 3: 'const void *' },
});

const INT_TYPE_WORDS = new Set([
  'char', 'short', 'int', 'long', 'signed', 'unsigned', '_Bool', 'bool', '__int128',
  'size_t', 'ssize_t', 'ptrdiff_t', 'uintptr_t', 'intptr_t', 'wchar_t',
]);

function skipQuoted(text, start) {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === quote) return i;
  }
  return text.length - 1;
}

function skipBlockComment(text, start) {
  const end = text.indexOf('*/', start + 2);
  return end < 0 ? text.length - 1 : end + 1;
}

function stripOuterParens(text) {
  let s = String(text ?? '').trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0;
    let wrapsAll = true;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"' || ch === "'") { i = skipQuoted(s, i); continue; }
      if (ch === '/' && s[i + 1] === '*') { i = skipBlockComment(s, i); continue; }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0 && i < s.length - 1) { wrapsAll = false; break; }
      }
    }
    if (!wrapsAll) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

function findTopLevelTernary(expr) {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let qIdx = -1;
  let qDepth = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '"' || ch === "'") { i = skipQuoted(expr, i); continue; }
    if (ch === '/' && expr[i + 1] === '*') { i = skipBlockComment(expr, i); continue; }
    if (ch === '(') { paren++; continue; }
    if (ch === ')') { if (paren > 0) paren--; continue; }
    if (ch === '[') { bracket++; continue; }
    if (ch === ']') { if (bracket > 0) bracket--; continue; }
    if (ch === '{') { brace++; continue; }
    if (ch === '}') { if (brace > 0) brace--; continue; }
    if (paren === 0 && bracket === 0 && brace === 0) {
      if (ch === '?') {
        if (qIdx < 0) qIdx = i;
        qDepth++;
      } else if (ch === ':' && qIdx >= 0) {
        qDepth--;
        if (qDepth === 0) return { qIdx, cIdx: i };
      }
    }
  }
  return null;
}

function findLowestTopLevelBinaryOp(expr) {
  // Returns { op, index, len, prec } for lowest-precedence binary operator at depth 0.
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let best = null;
  let prevNonWs = '';
  const isUnaryPos = () => prevNonWs === '' || /[=(,[?:!~+\-*/%&|^<>]/.test(prevNonWs);

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '"' || ch === "'") { i = skipQuoted(expr, i); prevNonWs = '"'; continue; }
    if (ch === '/' && expr[i + 1] === '*') { i = skipBlockComment(expr, i); continue; }
    if (/\s/.test(ch)) continue;
    if (ch === '(') { paren++; prevNonWs = ch; continue; }
    if (ch === ')') { if (paren > 0) paren--; prevNonWs = ch; continue; }
    if (ch === '[') { bracket++; prevNonWs = ch; continue; }
    if (ch === ']') { if (bracket > 0) bracket--; prevNonWs = ch; continue; }
    if (ch === '{') { brace++; prevNonWs = ch; continue; }
    if (ch === '}') { if (brace > 0) brace--; prevNonWs = ch; continue; }

    if (paren === 0 && bracket === 0 && brace === 0 && !isUnaryPos()) {
      const two = expr.slice(i, i + 2);
      let op = null;
      let len = 1;
      let prec = 99;
      if (two === '||') { op = two; len = 2; prec = 1; }
      else if (two === '&&') { op = two; len = 2; prec = 2; }
      else if (ch === '|' && expr[i + 1] !== '=') { op = '|'; prec = 3; }
      else if (ch === '^' && expr[i + 1] !== '=') { op = '^'; prec = 4; }
      else if (ch === '&' && expr[i + 1] !== '=') { op = '&'; prec = 5; }
      else if (two === '==' || two === '!=') { op = two; len = 2; prec = 6; }
      else if (two === '<=' || two === '>=') { op = two; len = 2; prec = 7; }
      else if ((ch === '<' || ch === '>') && expr[i + 1] !== ch) { op = ch; prec = 7; }
      else if (two === '<<' || two === '>>') { op = two; len = 2; prec = 8; }
      else if (ch === '+' && expr[i + 1] !== '+' && expr[i + 1] !== '=') { op = '+'; prec = 9; }
      else if (ch === '-' && expr[i + 1] !== '-' && expr[i + 1] !== '>' && expr[i + 1] !== '=') { op = '-'; prec = 9; }
      else if ((ch === '*' || ch === '/' || ch === '%') && expr[i + 1] !== '=') { op = ch; prec = 10; }

      if (op) {
        if (!best || prec <= best.prec) best = { op, index: i, len, prec };
        if (len === 2) i++;
        prevNonWs = op[op.length - 1];
        continue;
      }
    }
    prevNonWs = ch;
  }
  return best;
}

function isCastTypeText(castInner) {
  const s = castInner.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  if (s === 'id') return 'ptr';
  if (/^(?:(?:const|volatile|restrict|struct|union|enum|unsigned|signed|short|long)\s+)*[A-Za-z_][A-Za-z0-9_]*(?:\s+(?:const|volatile|restrict))*\s*\*+(?:\s*(?:const|volatile|restrict))*$/.test(s)) {
    return 'ptr';
  }
  if (/^\s*(?:const\s+|volatile\s+)?(?:void|char|short|int|long|unsigned|signed|__int128)\b.*\*\s*$/.test(s)) {
    return 'ptr';
  }
  if (/^(?:(?:const|volatile)\s+)*(?:float|double|long\s+double)$/.test(s)) return 'float';
  if (FIXED_WIDTH_TYPES.has(s) || INT_TYPE_WORDS.has(s) || s === 'vector128') return 'int';
  if (/^(?:(?:const|volatile|unsigned|signed|short|long)\s+)*(?:char|short|int|long|_Bool|bool|__int128)$/.test(s)) {
    return 'int';
  }
  return null;
}

function classifyExprType(expr, ptrNames, intNames, floatNames = null, selfCallSpec = null) {
  const t = stripOuterParens(expr);
  if (!t) return 'unknown';

  // 1. Null / zero constants.
  if (/^(?:0(?:[xX]0+)?[uUlL]*|NULL)$/.test(t)) return 'zero';

  // 2. String literal.
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) return 'ptr';

  // 3. Non-zero numeric or char literal.
  if (/^(?:0[xX][0-9A-Fa-f]+|0[bB][01]+|\d+)[uUlL]*$/.test(t)) return 'int';
  if (/^(?:\d+\.\d*(?:[eE][+-]?\d+)?|\d+[eE][+-]?\d+|\.\d+(?:[eE][+-]?\d+)?|0[xX][0-9A-Fa-f]*(?:\.[0-9A-Fa-f]+)?[pP][+-]?\d+)[fFlL]?$/.test(t)) return 'float';
  if (/^'(?:[^'\\]|\\.)+'$/.test(t)) return 'int';

  // 4. Top-level ternary (lowest precedence).
  const tern = findTopLevelTernary(t);
  if (tern) {
    const t1 = classifyExprType(t.slice(tern.qIdx + 1, tern.cIdx), ptrNames, intNames, floatNames, selfCallSpec);
    const t2 = classifyExprType(t.slice(tern.cIdx + 1), ptrNames, intNames, floatNames, selfCallSpec);
    if (t1 === 'ptr' && (t2 === 'ptr' || t2 === 'zero')) return 'ptr';
    if (t2 === 'ptr' && (t1 === 'ptr' || t1 === 'zero')) return 'ptr';
    if ((t1 === 'int' || t1 === 'zero') && (t2 === 'int' || t2 === 'zero')) return 'int';
    if (t1 === 'float' || t2 === 'float') return 'float';
    if ((t1 === 'ptr' && t2 === 'int') || (t1 === 'int' && t2 === 'ptr')) return 'mixed';
    return 'unknown';
  }

  // 5. Top-level binary operator.
  const bin = findLowestTopLevelBinaryOp(t);
  if (bin) {
    if (['||', '&&', '==', '!=', '<=', '>=', '<', '>', '|', '^', '&', '<<', '>>', '%'].includes(bin.op)) {
      return 'int';
    }
    const leftT = classifyExprType(t.slice(0, bin.index), ptrNames, intNames, floatNames, selfCallSpec);
    const rightT = classifyExprType(t.slice(bin.index + bin.len), ptrNames, intNames, floatNames, selfCallSpec);
    if (['*', '/'].includes(bin.op)) {
      if (leftT === 'float' || rightT === 'float') return 'float';
      return 'int';
    }
    if (bin.op === '+') {
      if (leftT === 'ptr' || rightT === 'ptr') return 'ptr';
      if (leftT === 'float' || rightT === 'float') return 'float';
      return 'int';
    }
    if (bin.op === '-') {
      if (leftT === 'ptr' && rightT !== 'ptr') return 'ptr';
      if (leftT === 'float' || rightT === 'float') return 'float';
      return 'int';
    }
  }

  // 6. Top-level C cast `(Type)subexpr`.
  if (t.startsWith('(')) {
    let depth = 0;
    let closeIdx = -1;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (ch === '"' || ch === "'") { i = skipQuoted(t, i); continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { closeIdx = i; break; } }
    }
    if (closeIdx > 0 && closeIdx < t.length - 1) {
      const castKind = isCastTypeText(t.slice(1, closeIdx));
      if (castKind) return castKind;
      // Indirect function pointer call: ((uint64 (*)(...))...)(args)
      const rest = t.slice(closeIdx + 1).trim();
      if (rest.startsWith('(') && rest.endsWith(')')) {
        const inner = t.slice(1, closeIdx).trim();
        if (/^\(\s*(?:id|[^()]+\*)\s*\(\s*\*\s*\)/.test(inner)) return 'ptr';
        return 'int';
      }
      // Parenthesized member access `(expr)->field` or `(expr).field` or subscript `(expr)[i]`
      if (/^(?:->|\.)\s*[A-Za-z_][A-Za-z0-9_]*$/.test(rest)) return 'int';
      if (rest.startsWith('[') && rest.endsWith(']')) return 'int';
    }
  }

  // 7. Unary dereference `*(Type *)(...)`.
  if (t.startsWith('*')) {
    const rest = t.slice(1).trim();
    if (rest.startsWith('(')) {
      const closeIdx = rest.indexOf(')');
      if (closeIdx > 0) {
        const inner = rest.slice(1, closeIdx).trim();
        if (/\*\s*\*\s*$/.test(inner)) return 'ptr';
        const base = inner.replace(/\*+\s*$/, '').trim().replace(/^(?:const|volatile)\s+/, '').replace(/\s+/g, ' ');
        if (base === 'id') return 'ptr';
        if (base === 'float' || base === 'double' || base === 'long double') return 'float';
        if (FIXED_WIDTH_TYPES.has(base) || INT_TYPE_WORDS.has(base)) return 'int';
      }
    }
    return 'unknown';
  }

  // 8. Address-of `&expr`.
  if (t.startsWith('&') && !t.startsWith('&&')) return 'ptr';

  // 9. Unary !, ~, +, -.
  if (/^[!~]/.test(t)) return 'int';
  if (/^[+-]/.test(t)) {
    const innerT = classifyExprType(t.slice(1), ptrNames, intNames, floatNames, selfCallSpec);
    return innerT === 'float' ? 'float' : 'int';
  }

  // 10. ObjC message send `[recv sel]` -> leave unknown so ObjC display mode stays untouched.
  if (t.startsWith('[')) return 'unknown';

  // 11. Direct function call `fn(...)`.
  const callMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(t);
  if (callMatch && t.endsWith(')')) {
    const callee = callMatch[1];
    if (STDLIB_PTR_RETURN_FUNCTIONS.has(callee)) return 'ptr';
    if (selfCallSpec && callee === selfCallSpec.name) {
      if (selfCallSpec.retIsPtr) return 'ptr';
      if (selfCallSpec.retIsFloat) return 'float';
      if (selfCallSpec.retIsInt) return 'int';
    }
    return 'int';
  }

  // 12. Array subscript `base[...]` or member access `a->f` / `s.f` or postfix `a++`/`a--`.
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*\[/.test(t) && t.endsWith(']')) return 'int';
  if (/^[A-Za-z_][A-Za-z0-9_]*(?:\s*(?:->|\.)\s*[A-Za-z_][A-Za-z0-9_]*)+$/.test(t)) return 'int';
  const postInc = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\+\+|--)$/.exec(t);
  if (postInc) {
    if (ptrNames.has(postInc[1])) return 'ptr';
    if (intNames.has(postInc[1])) return 'int';
  }

  // 13. Single identifier.
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
    if (ptrNames.has(t)) return 'ptr';
    if (floatNames && floatNames.has(t)) return 'float';
    if (intNames.has(t)) return 'int';
  }

  return 'unknown';
}

function isFloatExpr(expr, floatNames) {
  const t = stripOuterParens(expr);
  if (!t) return false;
  if (/^(?:\d+\.\d*(?:[eE][+-]?\d+)?|\d+[eE][+-]?\d+|\.\d+(?:[eE][+-]?\d+)?|0[xX][0-9A-Fa-f]*(?:\.[0-9A-Fa-f]+)?[pP][+-]?\d+)[fFlL]?$/.test(t)) {
    return true;
  }
  const tern = findTopLevelTernary(t);
  if (tern) {
    return isFloatExpr(t.slice(tern.qIdx + 1, tern.cIdx), floatNames)
      || isFloatExpr(t.slice(tern.cIdx + 1), floatNames);
  }
  const bin = findLowestTopLevelBinaryOp(t);
  if (bin) {
    if (['+', '-', '*', '/'].includes(bin.op)) {
      return isFloatExpr(t.slice(0, bin.index), floatNames)
        || isFloatExpr(t.slice(bin.index + bin.len), floatNames);
    }
    return false;
  }
  if (t.startsWith('(')) {
    let depth = 0;
    let closeIdx = -1;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (ch === '"' || ch === "'") { i = skipQuoted(t, i); continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { closeIdx = i; break; } }
    }
    if (closeIdx > 0 && closeIdx < t.length - 1) {
      const castKind = isCastTypeText(t.slice(1, closeIdx));
      if (castKind === 'float') return true;
      if (castKind === 'int' || castKind === 'ptr') return false;
    }
  }
  if (t.startsWith('*')) {
    const rest = t.slice(1).trim();
    if (rest.startsWith('(')) {
      const closeIdx = rest.indexOf(')');
      if (closeIdx > 0) {
        const base = rest.slice(1, closeIdx).replace(/\*+\s*$/, '').trim().replace(/^(?:const|volatile)\s+/, '').replace(/\s+/g, ' ');
        if (base === 'float' || base === 'double' || base === 'long double') return true;
      }
    }
    return false;
  }
  if (/^[+-]/.test(t) && !t.startsWith('++') && !t.startsWith('--')) {
    return isFloatExpr(t.slice(1), floatNames);
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t) && floatNames && floatNames.has(t)) return true;
  return false;
}

function isNonStructPointerTypeText(typeText) {
  const cleaned = String(typeText ?? '')
    .replace(/\*+/g, ' ')
    .replace(/\b(?:const|volatile|restrict|static|extern|register)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (!cleaned) return false;
  if (cleaned === 'void' || cleaned === 'id' || cleaned === 'float' || cleaned === 'double' || cleaned === 'long double') return true;
  if (FIXED_WIDTH_TYPES.has(cleaned) || INT_TYPE_WORDS.has(cleaned)) return true;
  if (/^(?:(?:unsigned|signed|short|long)\s+)*(?:char|short|int|long|_Bool|bool|__int128)$/.test(cleaned)) return true;
  return false;
}

function buildSymbolTypeTable(sigText, lines, standaloneGlobals) {
  const ptrNames = new Set();
  const nonStructPtrNames = new Set();
  const intNames = new Set();
  const floatNames = new Set();
  const selfParams = [];
  const cleanSig = declarationBearingSource(sigText);
  const open = cleanSig.indexOf('(');
  const selfName = signatureFunctionName(sigText);
  let retType = '';
  let retIsPtr = false;
  let retIsInt = false;
  let retIsFloat = false;

  if (open >= 0) {
    let prefix = cleanSig.slice(0, open).trim();
    if (/[+-]\[[^\]]+\]\s*$/.test(prefix)) {
      prefix = prefix.replace(/[+-]\[[^\]]+\]\s*$/, '').trim();
    } else {
      prefix = prefix.replace(/[A-Za-z_][A-Za-z0-9_]*\s*$/, '').trim();
    }
    prefix = prefix.replace(/^(?:(?:static|extern|inline|__inline__|__inline)\s+)+/, '').trim();
    retType = prefix.replace(/\s+/g, ' ');
    retIsPtr = retType.includes('*') || retType === 'id';
    retIsFloat = !retIsPtr && /\b(?:float|double)\b/.test(retType);
    retIsInt = !retIsPtr && !retIsFloat && retType !== 'void' && retType.length > 0;

    const close = findMatchingDelimiter(cleanSig, open, '(', ')');
    if (close > open) {
      let paramIdx = 0;
      for (const rawGroup of splitTopLevelCommas(cleanSig.slice(open + 1, close))) {
        const group = rawGroup.trim();
        if (!group || group === 'void' || group === '...') continue;
        if (group.includes('(*')) {
          const fpNameMatch = /\(\s*\*\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/.exec(group);
          selfParams.push({
            index: paramIdx++,
            type: null,
            kind: 'other',
          });
          if (fpNameMatch && !KEYWORDS.has(fpNameMatch[1])) {
            ptrNames.add(fpNameMatch[1]);
            intNames.delete(fpNameMatch[1]);
            floatNames.delete(fpNameMatch[1]);
          }
          continue;
        }
        const isArray = /\[[^\]]*\]\s*$/.test(group);
        const isPtr = group.includes('*') || /^(?:const\s+|volatile\s+)?id\b/.test(group) || isArray;
        const nameMatch = /([A-Za-z_][A-Za-z0-9_]*)(?:\s*\[[^\]]*\])*\s*$/.exec(group);
        const hasParamName = !!(nameMatch && !KEYWORDS.has(nameMatch[1]) && !FIXED_WIDTH_TYPES.has(nameMatch[1]));
        let paramType = hasParamName
          ? group.slice(0, nameMatch.index).trim().replace(/\s+/g, ' ')
          : group.replace(/(?:\s*\[[^\]]*\])+\s*$/, '').trim().replace(/\s+/g, ' ');
        if (isArray && paramType) {
          paramType = paramType.endsWith('*') ? `${paramType}*` : `${paramType} *`;
        }
        const isFloat = !isPtr && /\b(?:float|double)\b/.test(group);
        const isInt = !isPtr && !isFloat && !/\b(?:struct|union)\b/.test(group);
        selfParams.push({
          index: paramIdx++,
          type: paramType || (isPtr ? 'void *' : 'uint64'),
          kind: isPtr ? 'ptr' : isFloat ? 'float' : isInt ? 'int' : 'other',
        });
        if (!hasParamName) continue;
        if (isPtr) {
          ptrNames.add(nameMatch[1]);
          if (isNonStructPointerTypeText(paramType)) nonStructPtrNames.add(nameMatch[1]);
          intNames.delete(nameMatch[1]);
          floatNames.delete(nameMatch[1]);
        } else if (isFloat) {
          floatNames.add(nameMatch[1]);
          intNames.delete(nameMatch[1]);
        } else if (isInt) {
          intNames.add(nameMatch[1]);
        }
      }
    }
  }

  for (const item of lines || []) {
    if (!item || (item.kind !== 'decl' && item.kind !== 'stmt')) continue;
    const cleaned = declarationBearingSource(item.text).trim();
    if (!cleaned || /^typedef\b/.test(cleaned) || cleaned.startsWith('#')) continue;
    const noSemi = cleaned.replace(/;\s*$/, '').trim();
    const declarators = splitTopLevelCommas(noSemi);
    const firstHead = cutBeforeTopLevelAssign(declarators[0] || '').trim();
    if (!firstHead || firstHead.includes('(')) continue;
    const baseMatch = /^((?:(?:const|volatile|static|extern|register|unsigned|signed|short|long|struct|union|enum)\s+)*)([A-Za-z_][A-Za-z0-9_]*)\b/.exec(firstHead);
    if (!baseMatch || NON_DECL_STMT_HEADS.has(baseMatch[2])) continue;
    const baseType = baseMatch[2];
    const baseIsFloat = baseType === 'float' || baseType === 'double';
    const baseIsId = baseType === 'id';
    const baseIsInt = FIXED_WIDTH_TYPES.has(baseType) || INT_TYPE_WORDS.has(baseType);
    for (let idx = 0; idx < declarators.length; idx++) {
      const part = cutBeforeTopLevelAssign(declarators[idx]).trim();
      const body = idx === 0 ? part.slice(baseMatch[0].length).trim() : part;
      if (!body) continue;
      const isPtr = baseIsId || body.includes('*') || /\[[^\]]*\]\s*$/.test(body);
      const nameMatch = /([A-Za-z_][A-Za-z0-9_]*)(?:\s*\[[^\]]*\])?\s*$/.exec(body);
      if (!nameMatch || KEYWORDS.has(nameMatch[1])) continue;
      const varName = nameMatch[1];
      if (isPtr) {
        if (idx === 0 && !baseIsId && !body.startsWith('*') && !/\[[^\]]*\]\s*$/.test(body)) continue;
        ptrNames.add(varName);
        if (baseIsId || baseIsInt || baseIsFloat || baseType === 'void') nonStructPtrNames.add(varName);
        intNames.delete(varName);
        floatNames.delete(varName);
      } else if (baseIsFloat) {
        if (!ptrNames.has(varName)) floatNames.add(varName);
      } else if (baseIsInt) {
        if (!ptrNames.has(varName) && !floatNames.has(varName)) intNames.add(varName);
      }
    }
  }

  for (const entry of standaloneGlobals || []) {
    if (entry?.name && !ptrNames.has(entry.name)) intNames.add(entry.name);
  }

  const selfCallSpec = selfName ? { name: selfName, retType, retIsPtr, retIsInt, retIsFloat, params: selfParams } : null;
  return { ptrNames, nonStructPtrNames, intNames, floatNames, retType, retIsPtr, retIsInt, retIsFloat, selfCallSpec };
}

function splitCallArgs(argStr) {
  const args = [];
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let start = 0;
  for (let i = 0; i < argStr.length; i++) {
    const ch = argStr[i];
    if (ch === '"' || ch === "'") { i = skipQuoted(argStr, i); continue; }
    if (ch === '/' && argStr[i + 1] === '*') { i = skipBlockComment(argStr, i); continue; }
    if (ch === '(') paren++;
    else if (ch === ')') { if (paren > 0) paren--; }
    else if (ch === '[') bracket++;
    else if (ch === ']') { if (bracket > 0) bracket--; }
    else if (ch === '{') brace++;
    else if (ch === '}') { if (brace > 0) brace--; }
    else if (ch === ',' && paren === 0 && bracket === 0 && brace === 0) {
      args.push(argStr.slice(start, i));
      start = i + 1;
    }
  }
  const tail = argStr.slice(start);
  if (args.length || tail.trim().length) args.push(tail);
  return args;
}

const BUILTIN_INT_ARGS = Object.freeze({
  bit_extract: new Set([0]),
  bit_insert: new Set([0, 1]),
});

function rewriteBuiltinPtrArgs(text, ptrNames, intNames, floatNames = null, selfCallSpec = null) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const end = skipQuoted(text, i);
      out += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = skipBlockComment(text, i);
      out += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch) && (i === 0 || !/[A-Za-z0-9_.]/.test(text[i - 1])) && !(i >= 2 && text.slice(i - 2, i) === '->')) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
      const ident = text.slice(i, j);
      const spec = LP64_SIZE_T_BUILTIN_PTR_ARGS[ident] || null;
      const intArgSpec = !spec ? (BUILTIN_INT_ARGS[ident] || null) : null;
      const isSelfCall = !spec && !intArgSpec && selfCallSpec && ident === selfCallSpec.name && selfCallSpec.params.length > 0;
      if (spec || intArgSpec || isSelfCall) {
        let k = j;
        while (k < text.length && /\s/.test(text[k])) k++;
        if (text[k] === '(') {
          let depth = 0;
          let closeIdx = -1;
          for (let m = k; m < text.length; m++) {
            const c = text[m];
            if (c === '"' || c === "'") { m = skipQuoted(text, m); continue; }
            if (c === '/' && text[m + 1] === '*') { m = skipBlockComment(text, m); continue; }
            if (c === '(') depth++;
            else if (c === ')') { depth--; if (depth === 0) { closeIdx = m; break; } }
          }
          if (closeIdx > k) {
            const rawArgs = splitCallArgs(text.slice(k + 1, closeIdx));
            const rewrittenArgs = rawArgs.map((rawArg, idx) => {
              const nested = rewriteBuiltinPtrArgs(rawArg, ptrNames, intNames, floatNames, selfCallSpec);
              const trimmed = nested.trim();
              if (!trimmed) return nested;
              const lead = nested.slice(0, nested.indexOf(trimmed));
              const trail = nested.slice(nested.indexOf(trimmed) + trimmed.length);
              if (spec) {
                const castType = spec[idx];
                if (!castType) return nested;
                if (classifyExprType(trimmed, ptrNames, intNames, floatNames, selfCallSpec) === 'int') {
                  return `${lead}(${castType})(uintptr_t)(${trimmed})${trail}`;
                }
                return nested;
              }
              if (intArgSpec) {
                if (!intArgSpec.has(idx)) return nested;
                if (classifyExprType(trimmed, ptrNames, intNames, floatNames, selfCallSpec) === 'ptr') {
                  return `${lead}(uintptr_t)(${trimmed})${trail}`;
                }
                return nested;
              }
              const param = selfCallSpec.params[idx];
              if (!param || !param.type) return nested;
              const argType = classifyExprType(trimmed, ptrNames, intNames, floatNames, selfCallSpec);
              if (param.kind === 'ptr' && argType === 'int') {
                return `${lead}(${param.type})(uintptr_t)(${trimmed})${trail}`;
              }
              if (param.kind === 'int' && argType === 'ptr') {
                return `${lead}(uintptr_t)(${trimmed})${trail}`;
              }
              return nested;
            });
            out += text.slice(i, k + 1) + rewrittenArgs.join(',') + ')';
            i = closeIdx + 1;
            continue;
          }
        }
      }
      out += ident;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function findMatchingDelimRaw(text, openIdx, openCh, closeCh) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") { i = skipQuoted(text, i); continue; }
    if (ch === '/' && text[i + 1] === '*') { i = skipBlockComment(text, i); continue; }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function rewriteParenthesizedSubexprs(text, transform) {
  let out = '';
  let i = 0;
  let prevNonWs = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const end = skipQuoted(text, i);
      out += text.slice(i, end + 1);
      i = end + 1;
      prevNonWs = '"';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = skipBlockComment(text, i);
      out += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '[') {
      const closeIdx = findMatchingDelimRaw(text, i, '[', ']');
      if (closeIdx > i) {
        const isCSubscript = prevNonWs === ')' || prevNonWs === ']' || /[A-Za-z0-9_]/.test(prevNonWs);
        if (isCSubscript) {
          const inner = text.slice(i + 1, closeIdx);
          out += `[${transform(inner)}]`;
        } else {
          // ObjC message send `[recv sel:...]` -> preserve untouched.
          out += text.slice(i, closeIdx + 1);
        }
        i = closeIdx + 1;
        prevNonWs = ']';
        continue;
      }
    }
    if (ch === '(') {
      const closeIdx = findMatchingDelimRaw(text, i, '(', ')');
      if (closeIdx > i) {
        const inner = text.slice(i + 1, closeIdx);
        const parts = splitCallArgs(inner);
        const rewritten = parts.length > 1
          ? parts.map((p) => transform(p)).join(',')
          : transform(inner);
        out += `(${rewritten})`;
        i = closeIdx + 1;
        prevNonWs = ')';
        continue;
      }
    }
    out += ch;
    if (!/\s/.test(ch)) prevNonWs = ch;
    i++;
  }
  return out;
}

function harmonizeMixedTernaries(expr, ptrNames, intNames, floatNames = null, selfCallSpec = null) {
  const s = String(expr ?? '');
  if (!s.includes('?')) return s;
  const trimmed = s.trim();
  if (!trimmed.includes('?')) return s;
  const lead = s.slice(0, s.indexOf(trimmed));
  const trail = s.slice(s.indexOf(trimmed) + trimmed.length);

  // First harmonize any ternaries nested inside parenthesized/subscripted subexpressions.
  const withNested = rewriteParenthesizedSubexprs(
    trimmed,
    (inner) => harmonizeMixedTernaries(inner, ptrNames, intNames, floatNames, selfCallSpec),
  );

  const tern = findTopLevelTernary(withNested);
  if (!tern) {
    // Also check binary operands at depth 0 (e.g. `x + cond ? a : b` or `lhs = rhs`).
    const bin = findLowestTopLevelBinaryOp(withNested);
    if (bin) {
      const left = harmonizeMixedTernaries(withNested.slice(0, bin.index), ptrNames, intNames, floatNames, selfCallSpec);
      const right = harmonizeMixedTernaries(withNested.slice(bin.index + bin.len), ptrNames, intNames, floatNames, selfCallSpec);
      return `${lead}${left}${withNested.slice(bin.index, bin.index + bin.len)}${right}${trail}`;
    }
    return `${lead}${withNested}${trail}`;
  }
  const cond = harmonizeMixedTernaries(withNested.slice(0, tern.qIdx), ptrNames, intNames, floatNames, selfCallSpec);
  let arm1 = harmonizeMixedTernaries(withNested.slice(tern.qIdx + 1, tern.cIdx), ptrNames, intNames, floatNames, selfCallSpec);
  let arm2 = harmonizeMixedTernaries(withNested.slice(tern.cIdx + 1), ptrNames, intNames, floatNames, selfCallSpec);
  const t1 = classifyExprType(arm1, ptrNames, intNames, floatNames, selfCallSpec);
  const t2 = classifyExprType(arm2, ptrNames, intNames, floatNames, selfCallSpec);
  if (t1 === 'ptr' && t2 === 'int') {
    const a1Trim = arm1.trim();
    const a1Lead = arm1.slice(0, arm1.indexOf(a1Trim));
    const a1Trail = arm1.slice(arm1.indexOf(a1Trim) + a1Trim.length);
    arm1 = `${a1Lead}(uintptr_t)(${a1Trim})${a1Trail}`;
  } else if (t1 === 'int' && t2 === 'ptr') {
    const a2Trim = arm2.trim();
    const a2Lead = arm2.slice(0, arm2.indexOf(a2Trim));
    const a2Trail = arm2.slice(arm2.indexOf(a2Trim) + a2Trim.length);
    arm2 = `${a2Lead}(uintptr_t)(${a2Trim})${a2Trail}`;
  }
  return `${lead}${cond}?${arm1}:${arm2}${trail}`;
}

const BITWISE_BIN_OPS = new Set(['&', '|', '^', '<<', '>>', '%']);

function wrapFloatOperand(operand, floatNames) {
  const trim = operand.trim();
  if (!trim || !isFloatExpr(trim, floatNames)) return operand;
  const lead = operand.slice(0, operand.indexOf(trim));
  const trail = operand.slice(operand.indexOf(trim) + trim.length);
  return `${lead}(uint64)(${trim})${trail}`;
}

function sanitizeFloatBitwiseOps(expr, floatNames) {
  const s = String(expr ?? '');
  if (!/[&|^~%]|<<|>>/.test(s)) return s;
  const trimmed = s.trim();
  if (!trimmed) return s;
  const lead = s.slice(0, s.indexOf(trimmed));
  const trail = s.slice(s.indexOf(trimmed) + trimmed.length);

  // Recurse into parenthesized/subscripted subexpressions first.
  const withNested = rewriteParenthesizedSubexprs(
    trimmed,
    (inner) => sanitizeFloatBitwiseOps(inner, floatNames),
  );

  const tern = findTopLevelTernary(withNested);
  if (tern) {
    const cond = sanitizeFloatBitwiseOps(withNested.slice(0, tern.qIdx), floatNames);
    const arm1 = sanitizeFloatBitwiseOps(withNested.slice(tern.qIdx + 1, tern.cIdx), floatNames);
    const arm2 = sanitizeFloatBitwiseOps(withNested.slice(tern.cIdx + 1), floatNames);
    return `${lead}${cond}?${arm1}:${arm2}${trail}`;
  }

  const bin = findLowestTopLevelBinaryOp(withNested);
  if (bin) {
    let left = sanitizeFloatBitwiseOps(withNested.slice(0, bin.index), floatNames);
    let right = sanitizeFloatBitwiseOps(withNested.slice(bin.index + bin.len), floatNames);
    if (BITWISE_BIN_OPS.has(bin.op)) {
      left = wrapFloatOperand(left, floatNames);
      right = wrapFloatOperand(right, floatNames);
    }
    return `${lead}${left}${withNested.slice(bin.index, bin.index + bin.len)}${right}${trail}`;
  }

  if (withNested.startsWith('~')) {
    const inner = sanitizeFloatBitwiseOps(withNested.slice(1), floatNames);
    return `${lead}~${wrapFloatOperand(inner, floatNames)}${trail}`;
  }

  return `${lead}${withNested}${trail}`;
}

function splitTrailingComment(lineText) {
  let i = 0;
  while (i < lineText.length) {
    const ch = lineText[i];
    if (ch === '"' || ch === "'") { i = skipQuoted(lineText, i) + 1; continue; }
    if (ch === '/' && lineText[i + 1] === '/') {
      return { code: lineText.slice(0, i), comment: lineText.slice(i) };
    }
    if (ch === '/' && lineText[i + 1] === '*') {
      const end = skipBlockComment(lineText, i);
      if (!lineText.slice(end + 1).trim()) {
        return { code: lineText.slice(0, i), comment: lineText.slice(i) };
      }
      i = end + 1;
      continue;
    }
    i++;
  }
  return { code: lineText, comment: '' };
}

function splitTopLevelStatements(code) {
  const parts = [];
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let start = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"' || ch === "'") { i = skipQuoted(code, i); continue; }
    if (ch === '/' && code[i + 1] === '*') { i = skipBlockComment(code, i); continue; }
    if (ch === '(') paren++;
    else if (ch === ')') { if (paren > 0) paren--; }
    else if (ch === '[') bracket++;
    else if (ch === ']') { if (bracket > 0) bracket--; }
    else if (ch === '{') brace++;
    else if (ch === '}') { if (brace > 0) brace--; }
    else if (ch === ';' && paren === 0 && bracket === 0 && brace === 0) {
      parts.push({ text: code.slice(start, i), hasSemi: true });
      start = i + 1;
    }
  }
  if (start < code.length) parts.push({ text: code.slice(start), hasSemi: false });
  return parts;
}

function findTopLevelAssignment(stmt) {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let i = 0; i < stmt.length; i++) {
    const ch = stmt[i];
    if (ch === '"' || ch === "'") { i = skipQuoted(stmt, i); continue; }
    if (ch === '/' && stmt[i + 1] === '*') { i = skipBlockComment(stmt, i); continue; }
    if (ch === '(') { paren++; continue; }
    if (ch === ')') { if (paren > 0) paren--; continue; }
    if (ch === '[') { bracket++; continue; }
    if (ch === ']') { if (bracket > 0) bracket--; continue; }
    if (ch === '{') { brace++; continue; }
    if (ch === '}') { if (brace > 0) brace--; continue; }
    if (paren === 0 && bracket === 0 && brace === 0 && ch === '=' && stmt[i + 1] !== '=') {
      const prev = stmt[i - 1] || '';
      const prev2 = stmt.slice(Math.max(0, i - 2), i);
      if (prev === '!' || prev === '<' || prev === '>') {
        if (prev2 === '<<' || prev2 === '>>') {
          return { op: `${prev2}=`, start: i - 2, end: i + 1 };
        }
        continue;
      }
      if (['+', '-', '*', '/', '%', '&', '|', '^'].includes(prev)) {
        return { op: `${prev}=`, start: i - 1, end: i + 1 };
      }
      return { op: '=', start: i, end: i + 1 };
    }
  }
  return null;
}

function stripLeadingControlOrLabel(stmt) {
  let prefix = '';
  let rest = stmt;
  for (;;) {
    const lbl = /^(\s*[A-Za-z_][A-Za-z0-9_]*\s*:(?!:)\s*)/.exec(rest);
    if (lbl && !/^\s*(?:case|default)\b/.test(lbl[1])) {
      prefix += lbl[1];
      rest = rest.slice(lbl[1].length);
      continue;
    }
    const elseM = /^(\s*else\s+)/.exec(rest);
    if (elseM) {
      prefix += elseM[1];
      rest = rest.slice(elseM[1].length);
      continue;
    }
    const ifM = /^(\s*if\s*)\(/.exec(rest);
    if (ifM) {
      const openIdx = ifM[1].length;
      const closeIdx = findMatchingDelimRaw(rest, openIdx, '(', ')');
      if (closeIdx > openIdx) {
        let after = closeIdx + 1;
        while (after < rest.length && /\s/.test(rest[after])) after++;
        if (after < rest.length && rest[after] !== '{') {
          prefix += rest.slice(0, after);
          rest = rest.slice(after);
          continue;
        }
      }
    }
    break;
  }
  return { prefix, rest };
}

function classifyLhsDeclType(lhsText) {
  const cleaned = declarationBearingSource(lhsText).trim();
  const match = /^((?:(?:const|volatile|static|extern|register|unsigned|signed|short|long|struct|union|enum)\s+)*)([A-Za-z_][A-Za-z0-9_]*)(\s+(?:\*+\s*)*|\s*\*+\s*)([A-Za-z_][A-Za-z0-9_]*)$/.exec(cleaned);
  if (!match || NON_DECL_STMT_HEADS.has(match[2]) || KEYWORDS.has(match[4])) return null;
  const typeTok = match[2];
  if (match[3].includes('*') || typeTok === 'id') return 'ptr';
  if (typeTok === 'float' || typeTok === 'double') return 'float';
  if (FIXED_WIDTH_TYPES.has(typeTok) || INT_TYPE_WORDS.has(typeTok)) return 'int';
  return null;
}

function allocSyntheticArrowStructType(baseKey, field, existingTypes, existingStructFields, syntheticArrowStructs) {
  const baseName = `hex_struct_${baseKey}`;
  const compatible = (name) => {
    if (!existingTypes || !existingTypes.has(name)) return true;
    const knownFields = existingStructFields && existingStructFields.get(name);
    return !!(knownFields && knownFields.has(field));
  };
  let structType = baseName;
  if (!compatible(structType)) {
    structType = `${baseName}_arrow`;
    let suffix = 2;
    while (!compatible(structType)) {
      structType = `${baseName}_arrow_${suffix++}`;
    }
  }
  if (!existingTypes || !existingTypes.has(structType)) {
    let fields = syntheticArrowStructs.get(structType);
    if (!fields) {
      fields = new Set();
      syntheticArrowStructs.set(structType, fields);
    }
    fields.add(field);
  }
  return structType;
}

function rewriteArrowAccessesInCode(code, badArrowBases, syntheticArrowStructs, existingTypes = null, existingStructFields = null) {
  if (!code.includes('->') || !badArrowBases.size) return code;
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      const end = skipQuoted(code, i);
      out += code.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '/' && code[i + 1] === '/') {
      out += code.slice(i);
      break;
    }
    if (ch === '/' && code[i + 1] === '*') {
      const end = skipBlockComment(code, i);
      out += code.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch) && (i === 0 || !/[A-Za-z0-9_]/.test(code[i - 1]))) {
      let j = i;
      while (j < code.length && /[A-Za-z0-9_]/.test(code[j])) j++;
      const ident = code.slice(i, j);
      const beforeChar = previousChar(code, i);
      const beforeTrimmed = code.slice(0, i).trimEnd();
      const isMemberName = beforeChar === '.' || beforeTrimmed.endsWith('->');
      const prevWord = previousWord(code, i);
      if (!isMemberName && !['struct', 'union', 'enum', 'goto'].includes(prevWord) && badArrowBases.has(ident)) {
        let k = j;
        while (k < code.length && /\s/.test(code[k])) k++;
        if (code[k] === '-' && code[k + 1] === '>') {
          let fStart = k + 2;
          while (fStart < code.length && /\s/.test(code[fStart])) fStart++;
          if (fStart < code.length && /[A-Za-z_]/.test(code[fStart])) {
            let fEnd = fStart;
            while (fEnd < code.length && /[A-Za-z0-9_]/.test(code[fEnd])) fEnd++;
            const field = code.slice(fStart, fEnd);
            if (!KEYWORDS.has(field)) {
              let expr = ident;
              let chainKey = ident;
              let curEnd = fEnd;
              let curField = field;
              let lastWasOffsetDeref = false;
              let hopCount = 0;
              while (true) {
                const offsetMatch = /^field_([0-9A-Fa-f]+)$/.exec(curField);
                if (offsetMatch) {
                  expr = `*(uint64 *)((uintptr_t)(${expr}) + 0x${offsetMatch[1]})`;
                  lastWasOffsetDeref = true;
                } else {
                  const structType = allocSyntheticArrowStructType(chainKey, curField, existingTypes, existingStructFields, syntheticArrowStructs);
                  expr = `((${structType} *)(uintptr_t)(${expr}))->${curField}`;
                  lastWasOffsetDeref = false;
                }
                chainKey = `${chainKey}_${curField}`;
                hopCount++;
                let nextArrow = curEnd;
                while (nextArrow < code.length && /\s/.test(code[nextArrow])) nextArrow++;
                if (code[nextArrow] !== '-' || code[nextArrow + 1] !== '>') break;
                let nfStart = nextArrow + 2;
                while (nfStart < code.length && /\s/.test(code[nfStart])) nfStart++;
                if (nfStart >= code.length || !/[A-Za-z_]/.test(code[nfStart])) break;
                let nfEnd = nfStart;
                while (nfEnd < code.length && /[A-Za-z0-9_]/.test(code[nfEnd])) nfEnd++;
                const nextField = code.slice(nfStart, nfEnd);
                if (KEYWORDS.has(nextField)) break;
                curField = nextField;
                curEnd = nfEnd;
              }
              if (lastWasOffsetDeref) {
                let after = curEnd;
                while (after < code.length && /\s/.test(code[after])) after++;
                const nextTwo = code.slice(after, after + 2);
                const needsWrap = hopCount > 1 || nextTwo === '++' || nextTwo === '--' || nextTwo === '->'
                  || code[after] === '[' || code[after] === '.';
                out += needsWrap ? `(${expr})` : expr;
              } else {
                out += expr;
              }
              i = curEnd;
              continue;
            }
          }
        }
      }
      out += ident;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function rewriteNonStructArrowAccesses(lines, bodyOpen, symTable, existingTypes = null, existingStructFields = null) {
  const syntheticArrowStructs = new Map();
  if (bodyOpen < 0) return { lines, changed: false, syntheticArrowStructs };
  const badArrowBases = new Set([...symTable.intNames, ...(symTable.nonStructPtrNames || [])]);
  if (!badArrowBases.size) return { lines, changed: false, syntheticArrowStructs };
  let changed = false;
  const out = lines.map((item, index) => {
    if (index <= bodyOpen || !item || (item.kind !== 'stmt' && item.kind !== 'ctrl' && item.kind !== 'decl')) return item;
    const raw = String(item.text ?? '');
    if (!raw.includes('->')) return item;
    const { code, comment } = splitTrailingComment(raw);
    const rewritten = rewriteArrowAccessesInCode(code, badArrowBases, syntheticArrowStructs, existingTypes, existingStructFields);
    if (rewritten === code) return item;
    changed = true;
    return { ...item, text: rewritten + comment };
  });
  return { lines: out, changed, syntheticArrowStructs };
}

function rewriteStatementForIntConversion(stmtText, symTable) {
  const { ptrNames, intNames, floatNames, retType, retIsPtr, retIsInt, selfCallSpec } = symTable;
  let stmt = rewriteBuiltinPtrArgs(stmtText, ptrNames, intNames, floatNames, selfCallSpec);

  const { prefix: ctrlPrefix, rest: bodyStmt } = stripLeadingControlOrLabel(stmt);
  const sanitizedPrefix = ctrlPrefix
    ? sanitizeFloatBitwiseOps(harmonizeMixedTernaries(ctrlPrefix, ptrNames, intNames, floatNames, selfCallSpec), floatNames)
    : '';

  // Return statement (standalone or trailing after `if (...)` / `else` / `label:`).
  const retMatch = /^(\s*return\s+)([\s\S]+)$/.exec(bodyStmt);
  if (retMatch) {
    const prefix = sanitizedPrefix + retMatch[1];
    let expr = sanitizeFloatBitwiseOps(harmonizeMixedTernaries(retMatch[2], ptrNames, intNames, floatNames, selfCallSpec), floatNames);
    const exprTrim = expr.trim();
    const exprType = classifyExprType(exprTrim, ptrNames, intNames, floatNames, selfCallSpec);
    if (retIsPtr && exprType === 'int') {
      expr = `(${retType})(uintptr_t)(${exprTrim})`;
    } else if (retIsInt && exprType === 'ptr') {
      expr = `(uintptr_t)(${exprTrim})`;
    }
    return prefix + expr;
  }

  // General assignment (bare ident, deref store `*(T *)(...) = ...`, member, decl initializer, compound assign).
  const assign = findTopLevelAssignment(bodyStmt);
  if (assign) {
    const lhsRaw = bodyStmt.slice(0, assign.start);
    const lhsTrim = lhsRaw.trim();
    const op = assign.op;
    const rawRhs = bodyStmt.slice(assign.end);
    const rhsLeadMatch = /^(\s*)/.exec(rawRhs);
    const rhsLead = rhsLeadMatch ? rhsLeadMatch[1] : '';
    const rhsBody = rawRhs.slice(rhsLead.length);
    let rhs = findTopLevelAssignment(rhsBody)
      ? rewriteStatementForIntConversion(rhsBody, symTable)
      : sanitizeFloatBitwiseOps(harmonizeMixedTernaries(rhsBody, ptrNames, intNames, floatNames, selfCallSpec), floatNames);
    const rhsTrim = rhs.trim();

    if (['&=', '|=', '^=', '<<=', '>>=', '%='].includes(op) && isFloatExpr(rhsTrim, floatNames)) {
      rhs = `(uint64)(${rhsTrim})`;
    }

    let lhsType = null;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(lhsTrim) && !NON_DECL_STMT_HEADS.has(lhsTrim)) {
      if (intNames.has(lhsTrim)) lhsType = 'int';
      else if (ptrNames.has(lhsTrim)) lhsType = 'ptr';
      else if (floatNames && floatNames.has(lhsTrim)) lhsType = 'float';
    } else {
      lhsType = classifyLhsDeclType(lhsTrim) ?? classifyExprType(lhsTrim, ptrNames, intNames, floatNames, selfCallSpec);
    }

    const rhsType = classifyExprType(rhs.trim(), ptrNames, intNames, floatNames, selfCallSpec);
    if (lhsType === 'int' && rhsType === 'ptr') {
      rhs = `(uintptr_t)(${rhs.trim()})`;
    } else if (lhsType === 'ptr' && rhsType === 'int' && op === '=') {
      rhs = `(void *)(uintptr_t)(${rhs.trim()})`;
    }
    const lhsSanitized = sanitizeFloatBitwiseOps(harmonizeMixedTernaries(lhsRaw, ptrNames, intNames, floatNames, selfCallSpec), floatNames);
    return `${sanitizedPrefix}${lhsSanitized}${op}${rhsLead}${rhs}`;
  }

  return sanitizedPrefix + sanitizeFloatBitwiseOps(harmonizeMixedTernaries(bodyStmt, ptrNames, intNames, floatNames, selfCallSpec), floatNames);
}

function applyIntConversionCoercions(lines, bodyOpen, symTable) {
  if (bodyOpen < 0) return { lines, changed: false };
  const { ptrNames, intNames, floatNames, selfCallSpec } = symTable;
  let changed = false;
  const out = lines.map((item, index) => {
    if (index <= bodyOpen || !item || (item.kind !== 'stmt' && item.kind !== 'ctrl' && item.kind !== 'decl')) return item;
    const raw = String(item.text ?? '');
    if (!raw.trim()) return item;
    const { code, comment } = splitTrailingComment(raw);
    if (!code.trim()) return item;
    const parts = splitTopLevelStatements(code);
    let lineChanged = false;
    const rebuilt = parts.map((part) => {
      if (!part.hasSemi) {
        const withCalls = rewriteBuiltinPtrArgs(part.text, ptrNames, intNames, floatNames, selfCallSpec);
        const nextText = sanitizeFloatBitwiseOps(harmonizeMixedTernaries(withCalls, ptrNames, intNames, floatNames, selfCallSpec), floatNames);
        if (nextText !== part.text) lineChanged = true;
        return nextText;
      }
      const nextText = rewriteStatementForIntConversion(part.text, symTable);
      if (nextText !== part.text) lineChanged = true;
      return `${nextText};`;
    }).join('') + comment;
    if (!lineChanged) return item;
    changed = true;
    return { ...item, text: rebuilt };
  });
  return { lines: out, changed };
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
  const objcSigMatch = /[+-]\[([^\]]+)\]/.exec(declarationBearingSource(sigText));
  if (objcSigMatch) {
    for (const m of objcSigMatch[1].matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) declared.add(m[0]);
  }
  const entrySource = entryOriginSource(lines[sigIndex]);
  const bodyOpen = lines.findIndex((item, index) => index > sigIndex && item?.kind === 'ctrl' && item?.text === '{');
  const renderedInitial = render(lines);
  const renderedBody = bodyOpen >= 0 ? render(lines.slice(bodyOpen)) : '';
  const uses = scanIdentifierUses(renderedBody);
  const existingTypes = definedTypeAliases(lines);

  const memberBaseAccesses = collectMemberBaseAccesses(renderedBody);
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

  const declaredMemberBaseNames = new Set(memberBaseDeclarations.map((d) => {
    const m = /([A-Za-z_][A-Za-z0-9_]*)\s*;$/.exec(d.text);
    return m ? m[1] : '';
  }).filter(Boolean));
  const ptrTypedLocals = inferPointerTypedLocals(renderedBody, sigText);
  const mutablePtrReturnLocals = inferMutablePtrReturnLocals(renderedBody);
  const localDeclarations = [...uses.values()]
    .filter((entry) => isDeclarableLocal(entry, declared, declaredMemberBaseNames))
    .map((entry) => ({
      kind: 'decl', indent: 1, text: `${(() => {
        if (entry.subscriptBase && (entry.name === 'memory' || !entry.nonSubscriptValue)) return 'uint8_t *';
        const t = localDeclarationTypeFor(entry.name, result);
        if (t === 'uint64' && mutablePtrReturnLocals.has(entry.name)) return mutablePtrReturnLocals.get(entry.name);
        return t === 'uint64' && ptrTypedLocals.has(entry.name) ? 'const void *' : t;
      })()} ${entry.name};`,
      row: null, addr: null, note: null, source: entrySource,
    }));

  const allBodyDeclarations = [...memberBaseDeclarations, ...localDeclarations];
  const withDeclarationsRaw = allBodyDeclarations.length && bodyOpen >= 0
    ? [...lines.slice(0, bodyOpen + 1), ...allBodyDeclarations, ...lines.slice(bodyOpen + 1)]
    : lines;

  const existingStructFields = new Map();
  for (const item of [...lines, ...structPrelude]) {
    const parsed = parseSynthesizedStructPreludeDeclaration(item?.text);
    if (!parsed) continue;
    let fset = existingStructFields.get(parsed.name);
    if (!fset) {
      fset = new Set();
      existingStructFields.set(parsed.name, fset);
    }
    for (const f of parsed.fields) fset.add(f.name);
    existingTypes.add(parsed.name);
  }
  const symTable = buildSymbolTypeTable(sigText, withDeclarationsRaw, standaloneGlobals);
  const { lines: withArrowRewrites, changed: arrowChanged, syntheticArrowStructs } = rewriteNonStructArrowAccesses(withDeclarationsRaw, bodyOpen, symTable, existingTypes, existingStructFields);
  for (const structType of [...syntheticArrowStructs.keys()].sort(compareAscii)) {
    if (existingTypes.has(structType)) continue;
    const fields = syntheticArrowStructs.get(structType);
    if (!fields || !fields.size) continue;
    if (!structPrelude.length) {
      structPrelude.push({ kind: 'decl', indent: 0, text: STRUCT_PRELUDE_COMMENT, row: null, addr: null, note: null, source: entrySource });
    }
    structPrelude.push({
      kind: 'decl', indent: 0, text: `typedef struct { ${[...fields].sort(compareAscii).map((f) => `uint64 ${f};`).join(' ')} } ${structType};`,
      row: null, addr: null, note: null, source: entrySource,
    });
    existingTypes.add(structType);
  }
  const { lines: withDeclarations, changed: intConvChanged } = applyIntConversionCoercions(withArrowRewrites, bodyOpen, symTable);
  const bodyChanged = arrowChanged || intConvChanged;

  const withPostFixedPrelude = [...withDeclarations];
  const sigPtrParams = signaturePointerParams(sigText);
  const sigTypesByName = new Map();
  for (const { typeName, paramName } of sigPtrParams) {
    if (existingTypes.has(typeName)) continue;
    let fields = sigTypesByName.get(typeName);
    if (!fields) {
      fields = new Set();
      sigTypesByName.set(typeName, fields);
    }
    const access = memberBaseAccesses.get(paramName);
    if (access && access.fields.size) {
      for (const f of access.fields) fields.add(f);
    }
  }
  for (const typeName of [...sigTypesByName.keys()].sort(compareAscii)) {
    const fields = sigTypesByName.get(typeName);
    if (!structPrelude.length) {
      structPrelude.push({ kind: 'decl', indent: 0, text: STRUCT_PRELUDE_COMMENT, row: null, addr: null, note: null, source: entrySource });
    }
    const typedefText = fields && fields.size
      ? `typedef struct ${typeName} { ${[...fields].sort(compareAscii).map((f) => `uint64 ${f};`).join(' ')} } ${typeName};`
      : `typedef struct ${typeName} ${typeName};`;
    structPrelude.push({
      kind: 'decl', indent: 0, text: typedefText,
      row: null, addr: null, note: null, source: entrySource,
    });
    existingTypes.add(typeName);
  }

  const atomicPrelude = atomicCompatPreludeLines(uses, lines, entrySource);
  const bitfieldHelperPrelude = bitfieldHelperPreludeLines(uses, lines, entrySource);
  const bitfieldHelperNames = new Set();
  for (const l of [...lines, ...bitfieldHelperPrelude]) {
    const helperName = parseBitfieldHelperDefinition(l?.text);
    if (helperName) bitfieldHelperNames.add(helperName);
  }
  const macroDefinedCalls = new Set();
  for (const l of [...lines, ...atomicPrelude]) {
    const m = /^\s*#define\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(String(l?.text ?? ''));
    if (m) macroDefinedCalls.add(m[1]);
  }
  const sigFuncName = signatureFunctionName(sigText);
  const idTypedefPrelude = [];
  if (!existingTypes.has('id') && (/\bid\b/.test(declarationBearingSource(sigText)) || uses.has('id'))) {
    idTypedefPrelude.push({
      kind: 'decl', indent: 0, text: 'typedef void * id;',
      row: null, addr: null, note: null, source: entrySource,
    });
    existingTypes.add('id');
    declared.add('id');
  }
  const existingIncludes = new Set();
  for (const l of lines) {
    const inc = /^\s*#include\s*(<[A-Za-z0-9_./+-]+>)/.exec(String(l?.text ?? ''));
    if (inc) existingIncludes.add(inc[1]);
  }
  const neededStdlibHeaders = new Set();
  for (const entry of uses.values()) {
    if (!entry?.callTarget) continue;
    if (declared.has(entry.name) || macroDefinedCalls.has(entry.name) || entry.name === sigFuncName) continue;
    const header = STANDARD_C_LIBRARY_HEADERS.get(entry.name);
    if (header && !existingIncludes.has(header)) neededStdlibHeaders.add(header);
  }
  const stdlibIncludePrelude = [...neededStdlibHeaders]
    .sort(compareAscii)
    .map((header) => ({
      kind: 'decl', indent: 0, text: `#include ${header}`,
      row: null, addr: null, note: null, source: entrySource,
    }));

  const standalonePrototypes = [...uses.values()]
    .filter((entry) => entry?.callTarget
      && !declared.has(entry.name)
      && !KEYWORDS.has(entry.name)
      && !FIXED_WIDTH_TYPES.has(entry.name)
      && !STANDARD_KNOWN_TYPES.has(entry.name)
      && !STANDARD_C_LIBRARY_HEADERS.has(entry.name)
      && !macroDefinedCalls.has(entry.name)
      && !bitfieldHelperNames.has(entry.name)
      && !/^__builtin_/.test(entry.name)
      && entry.name !== '__HEX_ANY_ARGS'
      && entry.name !== sigFuncName)
    .sort((a, b) => compareAscii(a.name, b.name));
  const prototypePrelude = [];
  const needsAnyArgsMacro = (standalonePrototypes.length > 0 || /\b__HEX_ANY_ARGS\b/.test(renderedInitial))
    && !lines.some((l) => String(l?.text ?? '').includes('#define __HEX_ANY_ARGS'));
  if (needsAnyArgsMacro || standalonePrototypes.length) {
    prototypePrelude.push({ kind: 'decl', indent: 0, text: STANDALONE_PROTOTYPES_COMMENT, row: null, addr: null, note: null, source: entrySource });
    if (needsAnyArgsMacro) {
      prototypePrelude.push(
        { kind: 'decl', indent: 0, text: '#ifndef __HEX_ANY_ARGS', row: null, addr: null, note: null, source: entrySource },
        { kind: 'decl', indent: 0, text: '#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 202311L', row: null, addr: null, note: null, source: entrySource },
        { kind: 'decl', indent: 0, text: '#define __HEX_ANY_ARGS ...', row: null, addr: null, note: null, source: entrySource },
        { kind: 'decl', indent: 0, text: '#else', row: null, addr: null, note: null, source: entrySource },
        { kind: 'decl', indent: 0, text: '#define __HEX_ANY_ARGS', row: null, addr: null, note: null, source: entrySource },
        { kind: 'decl', indent: 0, text: '#endif', row: null, addr: null, note: null, source: entrySource },
        { kind: 'decl', indent: 0, text: '#endif', row: null, addr: null, note: null, source: entrySource },
      );
    }
    for (const entry of standalonePrototypes) {
      prototypePrelude.push({
        kind: 'decl', indent: 0, text: `uint64 ${entry.name} (__HEX_ANY_ARGS);`,
        row: null, addr: null, note: null, source: entrySource,
      });
    }
  }
  const postFixedPrelude = [...idTypedefPrelude, ...structPrelude, ...globalPrelude, ...prototypePrelude, ...atomicPrelude, ...bitfieldHelperPrelude];
  if (postFixedPrelude.length) withPostFixedPrelude.splice(sigIndex, 0, ...postFixedPrelude);

  const prelude = fixedWidthPreludeLines(render(withPostFixedPrelude), existingTypes)
    .map((item) => ({ ...item, source: entrySource }));
  if (!allBodyDeclarations.length && !postFixedPrelude.length && !prelude.length && !stdlibIncludePrelude.length && !bodyChanged) return result;

  const next = [...withPostFixedPrelude];
  const leadingPrelude = [...stdlibIncludePrelude, ...prelude];
  if (leadingPrelude.length) next.splice(sigIndex, 0, ...leadingPrelude);
  result.lines = next;
  result.pseudocode = render(next);
  if (typeof options.onLinesChanged === 'function') options.onLinesChanged(result);
  return result;
}
