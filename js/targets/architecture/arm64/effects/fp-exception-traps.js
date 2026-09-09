const FPCR = 'fpcr';

const FP_EXCEPTION_TRAP_CONTROL = Object.freeze({
  'invalid-operation': Object.freeze({ bit:'IOE', bitIndex:8 }),
  'divide-by-zero': Object.freeze({ bit:'DZE', bitIndex:9 }),
  overflow: Object.freeze({ bit:'OFE', bitIndex:10 }),
  underflow: Object.freeze({ bit:'UFE', bitIndex:11 }),
  inexact: Object.freeze({ bit:'IXE', bitIndex:12 }),
  'input-denormal': Object.freeze({ bit:'IDE', bitIndex:15 }),
});

const ALL_EXCEPTION_CLASSES = Object.freeze(Object.keys(FP_EXCEPTION_TRAP_CONTROL));
const ARITHMETIC_EXCEPTION_CLASSES = Object.freeze([
  'invalid-operation', 'overflow', 'underflow', 'inexact', 'input-denormal',
]);
const COMPARE_EXCEPTION_CLASSES = Object.freeze(['invalid-operation', 'input-denormal']);
const ROUND_TO_INTEGER_EXCEPTION_CLASSES = Object.freeze(['invalid-operation', 'inexact', 'input-denormal']);
const INTEGER_TO_FLOAT_EXCEPTION_CLASSES = Object.freeze(['overflow', 'inexact']);
const MINMAX_EXCEPTION_CLASSES = Object.freeze(['invalid-operation', 'input-denormal']);

const DIVIDE_LIKE = new Set(['fdiv','frecpe','frsqrte']);
const ARITHMETIC = new Set([
  'fadd','fsub','fmul','fsqrt','fmadd','fmsub','fnmadd','fnmsub','fmla','fmls','frecps','frsqrts','fcvt',
]);
const MINMAX = new Set(['fmax','fmin','fmaxnm','fminnm']);
const COMPARE = new Set(['fcmp','fcmpe','fccmp','fccmpe','fcmeq','fcmge','fcmgt','facge','facgt']);
const INTEGER_TO_FLOAT = new Set(['scvtf','ucvtf']);
const ROUND_TO_INTEGER = new Set([
  'fcvtas','fcvtau','fcvtms','fcvtmu','fcvtns','fcvtnu','fcvtps','fcvtpu','fcvtzs','fcvtzu',
  'frinta','frintm','frintn','frintp','frintx','frinti','frintz',
]);
const DEFAULT_FAULT_CACHE = new Map();

function arm64FpExceptionClassesForMnemonic(mnemonic) {
  if (typeof mnemonic !== 'string') return Object.freeze([]);
  const canonical = mnemonic.trim().toLowerCase();
  if (DIVIDE_LIKE.has(canonical)) return ALL_EXCEPTION_CLASSES;
  if (MINMAX.has(canonical)) return MINMAX_EXCEPTION_CLASSES;
  if (COMPARE.has(canonical)) return COMPARE_EXCEPTION_CLASSES;
  if (INTEGER_TO_FLOAT.has(canonical)) return INTEGER_TO_FLOAT_EXCEPTION_CLASSES;
  if (ROUND_TO_INTEGER.has(canonical)) return ROUND_TO_INTEGER_EXCEPTION_CLASSES;
  if (ARITHMETIC.has(canonical)) return ARITHMETIC_EXCEPTION_CLASSES;
  return Object.freeze([]);
}

function buildFault(operation, exceptionClasses, executionCondition) {
  const alternatives = [];
  const seen = new Set();
  for (const exceptionClass of exceptionClasses || []) {
    if (typeof exceptionClass !== 'string' || seen.has(exceptionClass)) continue;
    const control = FP_EXCEPTION_TRAP_CONTROL[exceptionClass];
    if (!control) continue;
    seen.add(exceptionClass);
    alternatives.push(Object.freeze({
      exceptionClass,
      trapEnableBit:control.bit,
      trapEnableBitIndex:control.bitIndex,
    }));
  }
  if (alternatives.length === 0) return null;

  return Object.freeze({
    kind:'arm64-floating-point-exception',
    condition:Object.freeze({
      kind:'arm64-fp-exception-trap',
      operation,
      fpcrRegisterId:FPCR,
      alternatives:Object.freeze(alternatives),
      exceptionPredicate:'operation-raises-class',
      trapSupportPredicate:'implementation-supports-class',
      ...(executionCondition == null ? {} : { executionCondition }),
    }),
    detail:Object.freeze({
      architecture:'arm64',
      synchronous:true,
      normalCompletionEffectsCommitOnFault:false,
      trappedStatusFlagUpdate:'not-the-untrapped-fpsr-cumulative-update',
      ordering:'after-fp-simd-access-check-before-normal-completion',
    }),
  });
}

export function arm64FpExceptionTrapFault(mnemonic, options = {}) {
  if (typeof mnemonic !== 'string') return null;
  const operation = mnemonic.trim().toLowerCase();
  if (!operation) return null;
  const customClasses = options?.exceptionClasses;
  const executionCondition = options?.executionCondition ?? null;
  if (customClasses == null && executionCondition == null && DEFAULT_FAULT_CACHE.has(operation)) {
    return DEFAULT_FAULT_CACHE.get(operation);
  }

  const exceptionClasses = customClasses ?? arm64FpExceptionClassesForMnemonic(operation);
  const fault = buildFault(operation, exceptionClasses, executionCondition);
  if (customClasses == null && executionCondition == null) DEFAULT_FAULT_CACHE.set(operation, fault);
  return fault;
}
