// Deterministic, non-LLM preprocessing ported from
// `evaluator/syntactic/auto_fixer_v3.py::preprocess_decompiled_code`
// at the pinned upstream commit.
//
// This is part of the published Step 2 method (it runs before the first compile
// and before any LLM call), so the raw lane must be able to measure with and
// without it rather than silently choosing one.
//
// Documented deviations from the Python source (see upstream-contract.md):
//   * Function-end detection uses the opening brace that terminates the matched
//     definition and a balanced-brace scan. The Python source instead searches
//     for the *next* `{` after the match, which can skip or overrun a body; the
//     intent (remove the whole stub definition) is preserved here.

const COMMON_TYPE_PATTERNS = [
  [/\b__int64\b/g, 'long long'],
  [/\b__int32\b/g, 'int'],
  [/\b__int16\b/g, 'short'],
  [/\b__int8\b/g, 'char'],
  [/\bunsigned __int64\b/g, 'unsigned long long'],
  [/\bunsigned __int32\b/g, 'unsigned int'],
  [/\bunsigned __int16\b/g, 'unsigned short'],
  [/\bunsigned __int8\b/g, 'unsigned char'],
];

const IDA_PATTERNS = [
  [/\b__fastcall\b/g, ''], [/\b__cdecl\b/g, ''], [/\b__stdcall\b/g, ''], [/\b__thiscall\b/g, ''],
  [/\b__usercall\b/g, ''], [/\b__userpurge\b/g, ''], [/\b__noreturn\b/g, ''], [/\b__spoils\b/g, ''],
  [/\b__pure\b/g, ''], [/\b_BOOL1\b/g, 'char'], [/\b_BOOL2\b/g, 'short'], [/\b_BOOL4\b/g, 'int'],
  [/\b_BYTE\b/g, 'unsigned char'], [/\b_WORD\b/g, 'unsigned short'], [/\b_DWORD\b/g, 'unsigned int'],
  [/\b_QWORD\b/g, 'unsigned long long'], [/\b_OWORD\b/g, 'unsigned long long'],
];

const GHIDRA_PATTERNS = [
  [/\bundefined8\b/g, 'unsigned long long'], [/\bundefined4\b/g, 'unsigned int'],
  [/\bundefined2\b/g, 'unsigned short'], [/\bundefined1\b/g, 'unsigned char'],
  [/\bundefined\s+\*/g, 'char *'], [/\bundefined\b/g, 'char'], [/\bcode\s*\*/g, 'void *'],
];

const BINARYAI_PATTERNS = [
  [/\bundefined8\b/g, 'unsigned long long'], [/\bundefined4\b/g, 'unsigned int'],
  [/\bundefined2\b/g, 'unsigned short'], [/\bundefined1\b/g, 'unsigned char'],
  [/\bundefined\s+\*/g, 'char *'], [/\bundefined\b/g, 'char'], [/\bcode\s*\*/g, 'void *'],
  [/\bulong\b/g, 'unsigned long'], [/\bEVP_PKEY_CTX\s*\*/g, 'void *'],
];

const ANGR_PATTERNS = [
  [/GLIBC_\d+\.\d+::(\w+)/g, '__glibc_$1'],
  [/\$x\b/g, '__dollar_x'],
  [/\$(\w+)/g, '__dollar_$1'],
  [/(?<![0-9])\.([a-zA-Z_]\w*)/g, '_$1'],
  [/\b(\w+)\.(\d+)\b/g, '$1_$2'],
  [/\buint128_t\b/g, 'unsigned long long'],
];

const RETDEC_PATTERNS = [
  [/\bint33_t\b/g, 'long long'],
  [/\bint128_t\b/g, 'long long'],
];

const DECOMPILER_PATTERNS = {
  ida: IDA_PATTERNS,
  ghidra: GHIDRA_PATTERNS,
  binaryai: BINARYAI_PATTERNS,
  angr: ANGR_PATTERNS,
  retdec: RETDEC_PATTERNS,
  unknown: [],
};

// Exact list from upstream `CRT_FUNCTION_NAMES`.
export const CRT_FUNCTION_NAMES = Object.freeze([
  '_start', 'start', '_start_c', '_start_main', '_init', '__init', 'init_proc', '__init_proc', '_init_proc',
  '_fini', '__fini', 'fini_proc', '_fini_proc', 'call_weak_fn', '_call_weak_fn',
  'deregister_tm_clones', '_deregister_tm_clones', 'register_tm_clones', '_register_tm_clones',
  '__do_global_dtors_aux', '_do_global_dtors_aux', '__do_global_ctors_aux', '_do_global_ctors_aux',
  'frame_dummy', '_frame_dummy', '__libc_csu_init', '_libc_csu_init', '__libc_csu_fini', '_libc_csu_fini',
  '__divsi3', '_divsi3', '.divsi3', '__aeabi_idiv', '__udivsi3', '_udivsi3', '.udivsi3', '__aeabi_uidiv',
  '__modsi3', '_modsi3', '.modsi3', '__aeabi_idivmod', '__umodsi3', '_umodsi3', '.umodsi3', '__aeabi_uidivmod',
  'divsi3_skip_div0_test', '.divsi3_skip_div0_test', '_divsi3_skip_div0_test', '__aeabi_ldiv0', '_aeabi_ldiv0',
  '__aeabi_ddiv', '__aeabi_fdiv', '__aeabi_dmul', '__aeabi_fmul', '__aeabi_dadd', '__aeabi_fadd',
  '__aeabi_dsub', '__aeabi_fsub', '__aeabi_d2iz', '__aeabi_f2iz', '__aeabi_i2d', '__aeabi_i2f', '__aeabi_read_tp',
  '__ashldi3', '_ashldi3', '__ashrdi3', '_ashrdi3', '__lshrdi3', '_lshrdi3', '__negdi2', '_negdi2',
  '__muldi3', '_muldi3', '__divdi3', '_divdi3', '__moddi3', '_moddi3', '__udivdi3', '_udivdi3',
  '__umoddi3', '_umoddi3', '__cmpdi2', '_cmpdi2', '__ucmpdi2', '_ucmpdi2', '__fixdfdi', '_fixdfdi',
  '__fixsfdi', '_fixsfdi', '__floatdidf', '_floatdidf', '__floatdisf', '_floatdisf',
  '__stack_chk_fail', '_stack_chk_fail', '__stack_chk_guard', '_stack_chk_guard',
  '__cxa_finalize', '_cxa_finalize', '__cxa_atexit', '_cxa_atexit', '__gxx_personality_v0',
  '_ITM_deregisterTMCloneTable', '_ITM_registerTMCloneTable',
  '__tls_get_addr', '_tls_get_addr', '__tls_get_offset', '_tls_get_offset',
  '_dl_relocate_static_pie', '_dl_starting_up', '_dl_argv',
  '__memcpy_chk', '__memmove_chk', '__memset_chk', '__strcpy_chk', '__strcat_chk', '__sprintf_chk', '__snprintf_chk',
  '__gmon_start__', '_gmon_start__', '__libc_start_main', '_libc_start_main', '_Jv_RegisterClasses',
]);

const COMMON_TYPEDEFS = `/* Auto-injected type definitions by preprocessor */
typedef unsigned char uint8_t;
typedef unsigned short uint16_t;
typedef unsigned int uint32_t;
typedef unsigned long long uint64_t;
typedef signed char int8_t;
typedef short int16_t;
typedef int int32_t;
typedef long long int64_t;
typedef unsigned long size_t;
typedef long ssize_t;
typedef unsigned long uintptr_t;
typedef long intptr_t;
typedef unsigned long ptrdiff_t;
typedef long long intmax_t;
typedef unsigned long long uintmax_t;
`;

const TYPEDEF_NEEDED = [
  /\buint8_t\b/, /\buint16_t\b/, /\buint32_t\b/, /\buint64_t\b/,
  /\bint8_t\b/, /\bint16_t\b/, /\bint32_t\b/, /\bint64_t\b/,
  /\bsize_t\b/, /\bssize_t\b/, /\buintptr_t\b/, /\bintptr_t\b/,
  /\bptrdiff_t\b/, /\bintmax_t\b/, /\buintmax_t\b/,
];

export function detectDecompiler(code) {
  const text = String(code);
  if (text.includes('// Decompiled by BinaryAI') || text.includes('// SHA256:')) return 'binaryai';
  if (text.includes('// Angr Decompilation') || text.includes('__ROL__(') || text.includes('$x')) return 'angr';
  if (text.includes('Retargetable Decompiler') || text.includes('int33_t')) return 'retdec';
  if (text.includes('__fastcall') || text.includes('__usercall')) return 'ida';
  if (text.includes('/* Function:') && !text.includes('Ghidra')) return 'ghidra';
  return 'unknown';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Remove one balanced-brace C definition starting at `openBraceIndex`. Returns
// the exclusive end index (after the closing brace) or -1 when unbalanced.
function balancedEnd(code, openBraceIndex) {
  let depth = 0;
  for (let index = openBraceIndex; index < code.length; index += 1) {
    const char = code[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function removeFunctionAt(code, openBraceIndex, funcName, removed) {
  const end = balancedEnd(code, openBraceIndex);
  if (end < 0) return code;
  removed.push(funcName);
  return `${code.slice(0, openBraceIndex)}\n/* CRT stub function ${funcName} removed by preprocessor */\n${code.slice(end)}`;
}

function removeCrtStubs(code, removed) {
  let text = code;
  for (const funcName of CRT_FUNCTION_NAMES) {
    const escaped = escapeRegExp(funcName);
    // Comment-based removal (IDA/Ghidra style headers).
    const commentPatterns = [
      new RegExp(`/\\* Function: ${escaped} @[^*]*\\*/`, 'g'),
      new RegExp(`// Function: ${escaped} at [^\\n]*\\n`, 'g'),
    ];
    for (const pattern of commentPatterns) {
      const matches = [...text.matchAll(pattern)];
      for (const match of matches.reverse()) {
        const brace = text.indexOf('{', match.index + match[0].length);
        if (brace < 0) continue;
        text = removeFunctionAt(text, brace, funcName, removed);
      }
    }
    // Definition-based removal (works for outputs without standard headers).
    const defPattern = new RegExp(
      `^(\\s*(?:__attribute__\\s*)?)?(?:inline\\s+)?(\\w+)\\s+${escaped}\\s*\\([^;)]*\\{`,
      'gm',
    );
    const defMatches = [...text.matchAll(defPattern)];
    for (const match of defMatches.reverse()) {
      const brace = match.index + match[0].length - 1;
      if (text[brace] !== '{') continue;
      text = removeFunctionAt(text, brace, funcName, removed);
    }
  }
  return text;
}

function injectTypedefs(code) {
  const needs = TYPEDEF_NEEDED.some((pattern) => pattern.test(code));
  if (!needs) return { code, injected: false };
  if (code.includes('typedef unsigned int uint32_t') || code.includes('typedef uint32_t')) {
    return { code, injected: false };
  }
  const lines = code.split('\n');
  let insertPosition = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const stripped = lines[index].trim();
    if (stripped.startsWith('#include') || stripped.startsWith('#define')) insertPosition = index + 1;
    else if (stripped.startsWith('/*') || stripped.startsWith('//')) continue;
    else if (stripped) break;
  }
  if (insertPosition > 0) {
    lines.splice(insertPosition, 0, COMMON_TYPEDEFS);
    return { code: lines.join('\n'), injected: true };
  }
  return { code: `${COMMON_TYPEDEFS}\n${code}`, injected: true };
}

export function preprocessDecompiledCode(code, { injectTypedefs: wantTypedefs = true, decompilerHint = null } = {}) {
  if (typeof code !== 'string') throw new TypeError('codefuse-preprocess-requires-text');
  let text = code;
  const stats = {
    detectedDecompiler: decompilerHint || detectDecompiler(text),
    removedFunctions: [],
    patternReplacements: {},
    injectedTypedefs: false,
  };

  for (const [pattern, replacement] of COMMON_TYPE_PATTERNS) {
    const count = (text.match(pattern) || []).length;
    if (count > 0) {
      text = text.replace(pattern, replacement);
      stats.patternReplacements[`common:${pattern.source}`] = count;
    }
  }

  for (const [pattern, replacement] of DECOMPILER_PATTERNS[stats.detectedDecompiler] ?? []) {
    const count = (text.match(pattern) || []).length;
    if (count > 0) {
      text = text.replace(pattern, replacement);
      stats.patternReplacements[`${stats.detectedDecompiler}:${pattern.source}`] = count;
    }
  }

  // Upstream collapses runs of spaces after pattern replacement; reproduced so
  // the preprocessing shape matches the published method.
  text = text.replace(/ +/g, ' ');

  text = removeCrtStubs(text, stats.removedFunctions);
  stats.removedFunctions = [...new Set(stats.removedFunctions)];

  if (wantTypedefs) {
    const result = injectTypedefs(text);
    text = result.code;
    stats.injectedTypedefs = result.injected;
  }

  return { code: text, stats };
}
