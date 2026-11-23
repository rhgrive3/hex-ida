/*
 * Fixed-arity external call knowledge used by the semantic decompiler.
 *
 * AAPCS64 tells us where arguments live, but it does not encode how many a
 * particular callee accepts. In particular, modelCall.args is only a snapshot
 * of live x0..x7 values at the call site; it is not arity evidence. Never turn
 * those merely-live registers into source-level arguments.
 */

const FIXED = new Map([
  // stdio
  ['puts', 1], ['putchar', 1], ['getchar', 0], ['fputs', 2], ['fgets', 3],
  ['fgetc', 1], ['fputc', 2], ['getc', 1], ['putc', 2], ['ungetc', 2],
  ['fopen', 2], ['fclose', 1], ['fflush', 1], ['fread', 4], ['fwrite', 4],
  ['fseek', 3], ['ftell', 1], ['rewind', 1], ['feof', 1], ['ferror', 1],
  ['perror', 1], ['remove', 1], ['rename', 2], ['fileno', 1],
  ['vprintf', 2], ['vfprintf', 3], ['vsprintf', 3], ['vsnprintf', 4],
  // string & memory
  ['strlen', 1], ['strnlen', 2], ['memcpy', 3], ['memmove', 3], ['memset', 3],
  ['memcmp', 3], ['memchr', 3], ['bzero', 2], ['bcopy', 3],
  ['strcmp', 2], ['strncmp', 3], ['strcasecmp', 2], ['strncasecmp', 3], ['strcoll', 2],
  ['strcpy', 2], ['stpcpy', 2], ['strncpy', 3], ['strcat', 2], ['strncat', 3],
  ['strchr', 2], ['strrchr', 2], ['strstr', 2], ['strpbrk', 2],
  ['strspn', 2], ['strcspn', 2], ['strtok', 2], ['strtok_r', 3],
  ['strdup', 1], ['strndup', 2], ['strxfrm', 3],
  ['memcpy_chk', 4], ['memmove_chk', 4], ['memset_chk', 4],
  ['strcpy_chk', 3], ['strncpy_chk', 4], ['strcat_chk', 3], ['strncat_chk', 4],
  // ctype
  ['tolower', 1], ['toupper', 1], ['isalpha', 1], ['isdigit', 1], ['isalnum', 1],
  ['isspace', 1], ['isupper', 1], ['islower', 1], ['isprint', 1], ['ispunct', 1],
  ['isxdigit', 1], ['iscntrl', 1], ['isgraph', 1], ['isblank', 1],
  ['ctype_b_loc', 0], ['ctype_toupper_loc', 0], ['ctype_tolower_loc', 0],
  ['errno_location', 0],
  // stdlib
  ['free', 1], ['malloc', 1], ['calloc', 2], ['realloc', 2],
  ['atoi', 1], ['atol', 1], ['atoll', 1], ['atof', 1],
  ['strtol', 3], ['strtoll', 3], ['strtoul', 3], ['strtoull', 3],
  ['strtod', 2], ['strtof', 2], ['strtold', 2],
  ['abs', 1], ['labs', 1], ['llabs', 1], ['div', 2], ['ldiv', 2], ['lldiv', 2],
  ['qsort', 4], ['bsearch', 5],
  ['exit', 1], ['abort', 0], ['rand', 0], ['srand', 1], ['getenv', 1], ['system', 1],
  // unistd / POSIX I/O
  ['close', 1], ['read', 3], ['write', 3], ['lseek', 3],
  // math (1-arg double/float/long double)
  ['fabs', 1], ['fabsf', 1], ['fabsl', 1],
  ['sqrt', 1], ['sqrtf', 1], ['sqrtl', 1],
  ['cbrt', 1], ['cbrtf', 1],
  ['floor', 1], ['floorf', 1], ['floorl', 1],
  ['ceil', 1], ['ceilf', 1], ['ceill', 1],
  ['round', 1], ['roundf', 1], ['roundl', 1],
  ['lround', 1], ['lroundf', 1], ['llround', 1], ['llroundf', 1],
  ['trunc', 1], ['truncf', 1], ['truncl', 1],
  ['rint', 1], ['rintf', 1], ['nearbyint', 1], ['nearbyintf', 1],
  ['sin', 1], ['sinf', 1], ['cos', 1], ['cosf', 1], ['tan', 1], ['tanf', 1],
  ['asin', 1], ['asinf', 1], ['acos', 1], ['acosf', 1], ['atan', 1], ['atanf', 1],
  ['sinh', 1], ['sinhf', 1], ['cosh', 1], ['coshf', 1], ['tanh', 1], ['tanhf', 1],
  ['exp', 1], ['expf', 1], ['exp2', 1], ['exp2f', 1], ['expm1', 1], ['expm1f', 1],
  ['log', 1], ['logf', 1], ['log2', 1], ['log2f', 1], ['log10', 1], ['log10f', 1], ['log1p', 1], ['log1pf', 1],
  ['isnan', 1], ['isinf', 1], ['isfinite', 1],
  // math (2-arg)
  ['pow', 2], ['powf', 2], ['powl', 2],
  ['fmod', 2], ['fmodf', 2], ['remainder', 2], ['remainderf', 2],
  ['atan2', 2], ['atan2f', 2], ['hypot', 2], ['hypotf', 2],
  ['fmin', 2], ['fminf', 2], ['fmax', 2], ['fmaxf', 2],
  ['copysign', 2], ['copysignf', 2],
  ['ldexp', 2], ['ldexpf', 2], ['frexp', 2], ['frexpf', 2], ['modf', 2], ['modff', 2],
  // math (3-arg)
  ['fma', 3], ['fmaf', 3],
]);

const VARIADIC_MIN = new Map([
  ['printf', 1], ['fprintf', 2], ['sprintf', 2], ['snprintf', 3],
  ['scanf', 1], ['fscanf', 2], ['sscanf', 2], ['dprintf', 2], ['asprintf', 2],
  ['isoc99_scanf', 1], ['isoc99_fscanf', 2], ['isoc99_sscanf', 2],
  ['sprintf_chk', 4], ['snprintf_chk', 5],
]);

const DOUBLE_1ARG = new Set([
  'fabs', 'fabsl', 'sqrt', 'sqrtl', 'cbrt', 'floor', 'floorl', 'ceil', 'ceill',
  'round', 'roundl', 'trunc', 'truncl', 'rint', 'nearbyint',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh',
  'exp', 'exp2', 'expm1', 'log', 'log2', 'log10', 'log1p',
]);
const FLOAT_1ARG = new Set([
  'fabsf', 'sqrtf', 'cbrtf', 'floorf', 'ceilf', 'roundf', 'truncf', 'rintf', 'nearbyintf',
  'sinf', 'cosf', 'tanf', 'asinf', 'acosf', 'atanf', 'sinhf', 'coshf', 'tanhf',
  'expf', 'exp2f', 'expm1f', 'logf', 'log2f', 'log10f', 'log1pf',
]);
const DOUBLE_2ARG = new Set([
  'pow', 'powl', 'fmod', 'remainder', 'atan2', 'hypot', 'fmin', 'fmax', 'copysign',
]);
const FLOAT_2ARG = new Set([
  'powf', 'fmodf', 'remainderf', 'atan2f', 'hypotf', 'fminf', 'fmaxf', 'copysignf',
]);

/*
 * Typed signature metadata for standard library & math callees used by type
 * recovery. Kept separate from `knownCallPrototype` so existing arity callers
 * and tests keep their exact `{ name, arity, variadic, confidence }` shape.
 */
const SIGNATURES = new Map([
  // Pointer-taking / pointer-returning libc functions
  ['puts', { retType: 'int', paramTypes: ['ptr'] }],
  ['strlen', { retType: 'size', paramTypes: ['ptr'] }],
  ['strnlen', { retType: 'size', paramTypes: ['ptr', 'size'] }],
  ['free', { retType: 'void', paramTypes: ['ptr'] }],
  ['malloc', { retType: 'ptr', paramTypes: ['size'] }],
  ['calloc', { retType: 'ptr', paramTypes: ['size', 'size'] }],
  ['realloc', { retType: 'ptr', paramTypes: ['ptr', 'size'] }],
  ['memcpy', { retType: 'ptr', paramTypes: ['ptr', 'ptr', 'size'] }],
  ['memmove', { retType: 'ptr', paramTypes: ['ptr', 'ptr', 'size'] }],
  ['memset', { retType: 'ptr', paramTypes: ['ptr', 'int', 'size'] }],
  ['memcmp', { retType: 'int', paramTypes: ['ptr', 'ptr', 'size'] }],
  ['memchr', { retType: 'ptr', paramTypes: ['ptr', 'int', 'size'] }],
  ['strcmp', { retType: 'int', paramTypes: ['ptr', 'ptr'] }],
  ['strncmp', { retType: 'int', paramTypes: ['ptr', 'ptr', 'size'] }],
  ['strcasecmp', { retType: 'int', paramTypes: ['ptr', 'ptr'] }],
  ['strncasecmp', { retType: 'int', paramTypes: ['ptr', 'ptr', 'size'] }],
  ['strcpy', { retType: 'ptr', paramTypes: ['ptr', 'ptr'] }],
  ['stpcpy', { retType: 'ptr', paramTypes: ['ptr', 'ptr'] }],
  ['strncpy', { retType: 'ptr', paramTypes: ['ptr', 'ptr', 'size'] }],
  ['strcat', { retType: 'ptr', paramTypes: ['ptr', 'ptr'] }],
  ['strncat', { retType: 'ptr', paramTypes: ['ptr', 'ptr', 'size'] }],
  ['strchr', { retType: 'ptr', paramTypes: ['ptr', 'int'] }],
  ['strrchr', { retType: 'ptr', paramTypes: ['ptr', 'int'] }],
  ['strstr', { retType: 'ptr', paramTypes: ['ptr', 'ptr'] }],
  ['strpbrk', { retType: 'ptr', paramTypes: ['ptr', 'ptr'] }],
  ['strspn', { retType: 'size', paramTypes: ['ptr', 'ptr'] }],
  ['strcspn', { retType: 'size', paramTypes: ['ptr', 'ptr'] }],
  ['strtok', { retType: 'ptr', paramTypes: ['ptr', 'ptr'] }],
  ['strdup', { retType: 'ptr', paramTypes: ['ptr'] }],
  ['strndup', { retType: 'ptr', paramTypes: ['ptr', 'size'] }],
  ['atoi', { retType: 'int', paramTypes: ['ptr'] }],
  ['atol', { retType: 'long', paramTypes: ['ptr'] }],
  ['atoll', { retType: 'long', paramTypes: ['ptr'] }],
  ['atof', { retType: 'double', paramTypes: ['ptr'] }],
  ['strtol', { retType: 'long', paramTypes: ['ptr', 'ptr', 'int'] }],
  ['strtoll', { retType: 'long', paramTypes: ['ptr', 'ptr', 'int'] }],
  ['strtoul', { retType: 'size', paramTypes: ['ptr', 'ptr', 'int'] }],
  ['strtoull', { retType: 'size', paramTypes: ['ptr', 'ptr', 'int'] }],
  ['strtod', { retType: 'double', paramTypes: ['ptr', 'ptr'] }],
  ['strtof', { retType: 'float', paramTypes: ['ptr', 'ptr'] }],
  ['qsort', { retType: 'void', paramTypes: ['ptr', 'size', 'size', 'ptr'] }],
  ['bsearch', { retType: 'ptr', paramTypes: ['ptr', 'ptr', 'size', 'size', 'ptr'] }],
  ['fopen', { retType: 'ptr', paramTypes: ['ptr', 'ptr'] }],
  ['fclose', { retType: 'int', paramTypes: ['ptr'] }],
  ['fflush', { retType: 'int', paramTypes: ['ptr'] }],
  ['fread', { retType: 'size', paramTypes: ['ptr', 'size', 'size', 'ptr'] }],
  ['fwrite', { retType: 'size', paramTypes: ['ptr', 'size', 'size', 'ptr'] }],
  ['fgets', { retType: 'ptr', paramTypes: ['ptr', 'int', 'ptr'] }],
  ['fputs', { retType: 'int', paramTypes: ['ptr', 'ptr'] }],
  ['printf', { retType: 'int', paramTypes: ['ptr'] }],
  ['fprintf', { retType: 'int', paramTypes: ['ptr', 'ptr'] }],
  ['sprintf', { retType: 'int', paramTypes: ['ptr', 'ptr'] }],
  ['snprintf', { retType: 'int', paramTypes: ['ptr', 'size', 'ptr'] }],
  ['scanf', { retType: 'int', paramTypes: ['ptr'] }],
  ['fscanf', { retType: 'int', paramTypes: ['ptr', 'ptr'] }],
  ['sscanf', { retType: 'int', paramTypes: ['ptr', 'ptr'] }],
  ['isoc99_scanf', { retType: 'int', paramTypes: ['ptr'] }],
  ['isoc99_fscanf', { retType: 'int', paramTypes: ['ptr', 'ptr'] }],
  ['isoc99_sscanf', { retType: 'int', paramTypes: ['ptr', 'ptr'] }],
  ['lround', { retType: 'long', paramTypes: ['double'] }],
  ['llround', { retType: 'long', paramTypes: ['double'] }],
  ['lroundf', { retType: 'long', paramTypes: ['float'] }],
  ['llroundf', { retType: 'long', paramTypes: ['float'] }],
  ['ldexp', { retType: 'double', paramTypes: ['double', 'int'] }],
  ['ldexpf', { retType: 'float', paramTypes: ['float', 'int'] }],
  ['frexp', { retType: 'double', paramTypes: ['double', 'ptr'] }],
  ['frexpf', { retType: 'float', paramTypes: ['float', 'ptr'] }],
  ['modf', { retType: 'double', paramTypes: ['double', 'ptr'] }],
  ['modff', { retType: 'float', paramTypes: ['float', 'ptr'] }],
  ['fma', { retType: 'double', paramTypes: ['double', 'double', 'double'] }],
  ['fmaf', { retType: 'float', paramTypes: ['float', 'float', 'float'] }],
  ['ctype_b_loc', { retType: 'ptr', paramTypes: [] }],
  ['ctype_toupper_loc', { retType: 'ptr', paramTypes: [] }],
  ['ctype_tolower_loc', { retType: 'ptr', paramTypes: [] }],
  ['errno_location', { retType: 'ptr', paramTypes: [] }],
]);

export function normalizeExternalSymbol(name) {
  if (typeof name !== 'string') return '';
  let s = name.trim();
  // Decoration stacks: `j__puts` / `imp__printf` carry a calling-side thunk or
  // import prefix over the usual C underscore decoration. Strip prefixes and
  // leading underscores repeatedly until neither applies, so the inner
  // decoration left behind by one removal is still normalized (#4143).
  for (;;) {
    const next = s.replace(/^_+/, '').replace(/^(?:imp_|j_)/, '');
    if (next === s) break;
    s = next;
  }
  const suffix = s.search(/(?:\$|@@?)/);
  if (suffix >= 0) s = s.slice(0, suffix);
  return s;
}

export function knownCallPrototype(name) {
  const normalized = normalizeExternalSymbol(name);
  if (FIXED.has(normalized)) return { name: normalized, arity: FIXED.get(normalized), variadic: false, confidence: 1 };
  if (VARIADIC_MIN.has(normalized)) return { name: normalized, arity: VARIADIC_MIN.get(normalized), variadic: true, confidence: 0.95 };
  return null;
}

export function knownCallSignature(name) {
  const proto = knownCallPrototype(name);
  if (!proto) return null;
  const n = proto.name;
  if (SIGNATURES.has(n)) {
    const sig = SIGNATURES.get(n);
    return { ...proto, retType: sig.retType, paramTypes: sig.paramTypes };
  }
  if (DOUBLE_1ARG.has(n)) return { ...proto, retType: 'double', paramTypes: ['double'] };
  if (FLOAT_1ARG.has(n)) return { ...proto, retType: 'float', paramTypes: ['float'] };
  if (DOUBLE_2ARG.has(n)) return { ...proto, retType: 'double', paramTypes: ['double', 'double'] };
  if (FLOAT_2ARG.has(n)) return { ...proto, retType: 'float', paramTypes: ['float', 'float'] };
  return { ...proto, retType: null, paramTypes: null };
}

function validArity(value) {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= 8
      ? value
      : null;
}

function range(n) {
  const count = Math.max(0, Math.min(8, Number(n) || 0));
  return Array.from({ length: count }, (_, i) => i);
}

/**
 * Return argument register indexes only when the count is supported by actual
 * prototype/API evidence. null means "arity unknown"; [] means proven zero.
 */
export function callArgumentIndices({ name, modelCall = null, override = null, defaultCallArgs = null } = {}) {
  const recoveredArity = validArity(override?.arity);
  if (recoveredArity != null) return range(recoveredArity);

  // Existing semantic API metadata may carry a fixed schema. The live values
  // in modelCall.args are deliberately ignored here.
  const apiArity = Array.isArray(modelCall?.api?.args) ? modelCall.api.args.length : null;
  if (apiArity != null) return range(apiArity);

  const known = knownCallPrototype(name);
  if (known) return range(known.arity); // Variadic entries expose only their proven fixed prefix.

  // Compatibility escape hatch for embedders that deliberately opt into a
  // guessed count. There is intentionally no built-in default.
  if (defaultCallArgs != null) return range(defaultCallArgs);
  return null;
}
