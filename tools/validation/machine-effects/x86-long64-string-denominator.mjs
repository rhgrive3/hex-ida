export const X86_LONG64_STRING_DENOMINATOR_SCHEMA = 'x86-long64-string-denominator/v1';
export const X86_LONG64_STRING_DENOMINATOR_ID = 'x86_64:long-64:effect-family:string:v1';
export const X86_LONG64_REPEATED_STRING_SUMMARY_SCHEMA = 'x86-repeated-string-summary/v1';

const OPERATIONS = Object.freeze([
  Object.freeze({ kind:'movs', byteOpcode:0xa4, variableOpcode:0xa5, source:true, destination:true, compare:false }),
  Object.freeze({ kind:'stos', byteOpcode:0xaa, variableOpcode:0xab, source:false, destination:true, compare:false }),
  Object.freeze({ kind:'lods', byteOpcode:0xac, variableOpcode:0xad, source:true, destination:false, compare:false }),
  Object.freeze({ kind:'cmps', byteOpcode:0xa6, variableOpcode:0xa7, source:true, destination:true, compare:true }),
  Object.freeze({ kind:'scas', byteOpcode:0xae, variableOpcode:0xaf, source:false, destination:true, compare:true }),
]);
const ELEMENT_FORMS = Object.freeze([
  Object.freeze({ widthBits:8, suffix:'b', operandPrefix:Object.freeze([]), rex:Object.freeze([]), opcode:'byte' }),
  Object.freeze({ widthBits:16, suffix:'w', operandPrefix:Object.freeze([0x66]), rex:Object.freeze([]), opcode:'variable' }),
  Object.freeze({ widthBits:32, suffix:'d', operandPrefix:Object.freeze([]), rex:Object.freeze([]), opcode:'variable' }),
  Object.freeze({ widthBits:64, suffix:'q', operandPrefix:Object.freeze([]), rex:Object.freeze([0x48]), opcode:'variable' }),
]);
const ADDRESS_FORMS = Object.freeze([
  Object.freeze({ widthBits:64, prefix:Object.freeze([]), id:'a64' }),
  Object.freeze({ widthBits:32, prefix:Object.freeze([0x67]), id:'a32' }),
]);
const SEGMENT_FORMS = Object.freeze([
  Object.freeze({ id:'default', segment:null, prefix:Object.freeze([]) }),
  Object.freeze({ id:'es', segment:'es', prefix:Object.freeze([0x26]) }),
  Object.freeze({ id:'cs', segment:'cs', prefix:Object.freeze([0x2e]) }),
  Object.freeze({ id:'ss', segment:'ss', prefix:Object.freeze([0x36]) }),
  Object.freeze({ id:'ds', segment:'ds', prefix:Object.freeze([0x3e]) }),
  Object.freeze({ id:'fs', segment:'fs', prefix:Object.freeze([0x64]) }),
  Object.freeze({ id:'gs', segment:'gs', prefix:Object.freeze([0x65]) }),
]);
const NON_COMPARE_REPEAT = Object.freeze([
  Object.freeze({ kind:null, prefix:Object.freeze([]), aliases:Object.freeze([]), condition:'single-element' }),
  Object.freeze({ kind:'rep', prefix:Object.freeze([0xf3]), aliases:Object.freeze(['rep']), condition:'remaining-count' }),
]);
const COMPARE_REPEAT = Object.freeze([
  Object.freeze({ kind:null, prefix:Object.freeze([]), aliases:Object.freeze([]), condition:'single-element' }),
  Object.freeze({ kind:'repe', prefix:Object.freeze([0xf3]), aliases:Object.freeze(['repe','repz']), condition:'updated-zf-equal' }),
  Object.freeze({ kind:'repne', prefix:Object.freeze([0xf2]), aliases:Object.freeze(['repne','repnz']), condition:'updated-zf-not-equal' }),
]);

function sourceSegment(operation, segment) {
  if (!operation.source) return null;
  return segment ?? 'ds';
}
function sourceSpace(operation, segment) {
  if (!operation.source) return null;
  return segment === 'fs' || segment === 'gs' ? 'tls' : 'memory';
}
function expectedFamily(operation, element) { return `${operation.kind}${element.suffix}`; }
function encoding(operation, element, address, segment, repeat) {
  const opcode = element.opcode === 'byte' ? operation.byteOpcode : operation.variableOpcode;
  return Uint8Array.from([
    ...repeat.prefix,
    ...segment.prefix,
    ...element.operandPrefix,
    ...address.prefix,
    ...element.rex,
    opcode,
  ]);
}

/**
 * Finite semantic discriminator denominator for long-mode x86 string effects.
 * Redundant prefix-order spellings are deliberately not separate cases: the
 * denominator varies every state-affecting discriminator and verifies malformed
 * or conflicting prefix state separately as a negative contract.
 */
export function* x86Long64StringDenominatorCases() {
  for (const operation of OPERATIONS) {
    const repeats = operation.compare ? COMPARE_REPEAT : NON_COMPARE_REPEAT;
    for (const element of ELEMENT_FORMS) {
      for (const address of ADDRESS_FORMS) {
        for (const segment of SEGMENT_FORMS) {
          for (const repeat of repeats) {
            const expectedSourceSegment = sourceSegment(operation,segment.segment);
            yield Object.freeze({
              id:`${operation.kind}:${element.widthBits}:${address.id}:${segment.id}:${repeat.kind ?? 'single'}`,
              bytes:encoding(operation,element,address,segment,repeat),
              family:expectedFamily(operation,element),
              operation:operation.kind,
              elementWidthBits:element.widthBits,
              elementBytes:element.widthBits / 8,
              addressSizeBits:address.widthBits,
              repeatKind:repeat.kind,
              repeatAliases:repeat.aliases,
              conditionBehavior:repeat.condition,
              sourceBehavior:Object.freeze({ present:operation.source, segment:expectedSourceSegment, space:sourceSpace(operation,segment.segment), pointerPhysical:operation.source?'rsi':null, pointerView:operation.source?(address.widthBits===32?'esi':'rsi'):null }),
              destinationBehavior:Object.freeze({ present:operation.destination, segment:operation.destination?'es':null, space:operation.destination?'memory':null, pointerPhysical:operation.destination?'rdi':null, pointerView:operation.destination?(address.widthBits===32?'edi':'rdi'):null }),
              countBehavior:repeat.kind == null ? null : Object.freeze({ physicalRegister:'rcx', view:address.widthBits===32?'ecx':'rcx', widthBits:address.widthBits }),
              flagsBehavior:Object.freeze({ compare:operation.compare, repeated:repeat.kind != null }),
            });
          }
        }
      }
    }
  }
}

export function x86Long64StringDenominatorIdentity() {
  const nonCompareOperations = OPERATIONS.filter((operation) => !operation.compare).length;
  const compareOperations = OPERATIONS.filter((operation) => operation.compare).length;
  const caseCount = ELEMENT_FORMS.length * ADDRESS_FORMS.length * SEGMENT_FORMS.length
    * (nonCompareOperations * NON_COMPARE_REPEAT.length + compareOperations * COMPARE_REPEAT.length);
  return Object.freeze({
    schemaVersion:X86_LONG64_STRING_DENOMINATOR_SCHEMA,
    denominatorId:X86_LONG64_STRING_DENOMINATOR_ID,
    operationCount:OPERATIONS.length,
    elementWidthCount:ELEMENT_FORMS.length,
    addressSizeCount:ADDRESS_FORMS.length,
    sourceSegmentDiscriminatorCount:SEGMENT_FORMS.length,
    nonCompareRepeatCount:NON_COMPARE_REPEAT.length,
    compareRepeatCount:COMPARE_REPEAT.length,
    semanticCaseCount:caseCount,
    dimensions:Object.freeze(['operation','prefix/repetition','address-size','element-width','source-segment','source/destination-behavior','condition-behavior']),
    negativeContracts:Object.freeze(['malformed-prefix','missing-implicit-state','ambiguous-movsd-cmpsd-shape','invalid-address-size','unsupported-form','rep-semantic-truncation']),
    oracleIds:Object.freeze(['intel-sdm-string-operation-semantics','deployed-capstone-5-x86-long64-detail','x86-repeated-string-summary/v1']),
  });
}

function intrinsicOf(bundle) { return bundle?.operations?.filter((operation) => operation?.kind === 'intrinsic') ?? []; }
function scopeIsComplete(scope) { return scope && scope.scope !== 'unknown'; }
function requireValue(errors, condition, code) { if (!condition) errors.push(code); }

/**
 * Independent proof-side gate for a repeated-string intrinsic.  This is kept
 * outside production specifically so a truncated production summary cannot
 * certify itself merely by returning exact-with-intrinsic.
 */
export function validateX86Long64RepeatedStringSummary(bundle, expected) {
  const errors = [], intrinsics = intrinsicOf(bundle);
  requireValue(errors,bundle?.completeness === 'exact-with-intrinsic','bundle-not-exact-with-intrinsic');
  requireValue(errors,bundle?.unknownEffects == null,'bundle-has-unknown-effects');
  requireValue(errors,intrinsics.length === 1,'intrinsic-count');
  const intrinsic = intrinsics[0];
  const summary = intrinsic?.effectSummary, metadata = intrinsic?.metadata;
  requireValue(errors,metadata?.summaryContractVersion === X86_LONG64_REPEATED_STRING_SUMMARY_SCHEMA,'summary-schema');
  requireValue(errors,metadata?.exactArchitecturalSummary === true,'summary-not-exact');
  requireValue(errors,metadata?.runtimeCountNotUnrolled === true,'runtime-count-contract');
  requireValue(errors,metadata?.operation === expected?.operation,'operation');
  requireValue(errors,metadata?.repeatKind === expected?.repeatKind,'repeat-kind');
  requireValue(errors,metadata?.elementWidthBits === expected?.elementWidthBits,'element-width');
  requireValue(errors,metadata?.addressSizeBits === expected?.addressSizeBits,'address-size');
  requireValue(errors,metadata?.count?.physicalRegister === 'rcx' && metadata?.count?.view === expected?.countBehavior?.view,'count-state');
  requireValue(errors,metadata?.count?.entryPredicate === 'count != 0','zero-count-entry');
  requireValue(errors,metadata?.count?.zeroCount?.includes('preserve full RCX'),'zero-count-rcx');
  requireValue(errors,metadata?.direction?.flag === 'DF' && metadata?.direction?.zeroDelta === expected?.elementBytes && metadata?.direction?.oneDelta === -expected?.elementBytes,'direction');
  requireValue(errors,metadata?.termination?.entry === 'count != 0','termination-entry');
  requireValue(errors,metadata?.termination?.normalControl === 'fallthrough','termination-control');
  requireValue(errors,metadata?.termination?.zeroCount?.includes('no data-memory access'),'zero-count-memory');
  requireValue(errors,metadata?.termination?.initialConditionFlagUsedBeforeFirstIteration === false,'initial-condition-gate');
  requireValue(errors,metadata?.memory?.kind === 'strided-runtime-count','memory-pattern');
  const expectedSteps = ({ movs:['source-read','destination-write','pointer/count-commit'], stos:['destination-write','pointer/count-commit'], lods:['source-read','accumulator-write','pointer/count-commit'], cmps:['source-read','destination-read','compare-flags-write','pointer/count-commit','termination-test'], scas:['accumulator-read','destination-read','compare-flags-write','pointer/count-commit','termination-test'] })[expected?.operation];
  requireValue(errors,JSON.stringify(metadata?.memory?.perIterationSteps) === JSON.stringify(expectedSteps),'per-iteration-order');
  requireValue(errors,metadata?.memory?.faultProgress?.includes('restart point'),'fault-progress');
  requireValue(errors,scopeIsComplete(summary?.memoryRead) && scopeIsComplete(summary?.memoryWrite),'memory-scope-incomplete');
  requireValue(errors,Array.isArray(summary?.inputs) && summary.inputs.length > 0,'intrinsic-inputs');
  requireValue(errors,Array.isArray(summary?.outputs) && summary.outputs.length === metadata?.outputRoles?.length,'intrinsic-outputs');
  requireValue(errors,metadata?.outputRoles?.some((entry) => entry.role === 'count' && entry.registerName === 'rcx'),'count-output');
  if (expected?.sourceBehavior?.present) {
    requireValue(errors,metadata?.memory?.source?.pointerPhysical === 'rsi' && metadata?.memory?.source?.pointerView === expected.sourceBehavior.pointerView,'source-pointer');
    requireValue(errors,metadata?.memory?.source?.segment === expected.sourceBehavior.segment && metadata?.memory?.source?.space === expected.sourceBehavior.space,'source-segment');
    requireValue(errors,metadata?.outputRoles?.some((entry) => entry.role === 'source-pointer' && entry.registerName === 'rsi'),'source-output');
  }
  if (expected?.destinationBehavior?.present) {
    requireValue(errors,metadata?.memory?.destination?.pointerPhysical === 'rdi' && metadata?.memory?.destination?.pointerView === expected.destinationBehavior.pointerView,'destination-pointer');
    requireValue(errors,metadata?.memory?.destination?.segment === 'es' && metadata?.memory?.destination?.space === 'memory','destination-segment');
    requireValue(errors,metadata?.outputRoles?.some((entry) => entry.role === 'destination-pointer' && entry.registerName === 'rdi'),'destination-output');
  }
  if (expected?.operation === 'lods') {
    requireValue(errors,metadata?.accumulator?.physicalRegister === 'rax' && metadata?.accumulator?.zeroCount === 'full RAX preserved','lods-accumulator');
    const requiredAccumulatorPhrase = expected.elementWidthBits === 8 ? 'preserves upper 56 bits' : expected.elementWidthBits === 16 ? 'preserves upper 48 bits' : expected.elementWidthBits === 32 ? 'zero-extends into full RAX' : 'replaces full RAX';
    requireValue(errors,metadata?.accumulator?.nonzero?.includes(requiredAccumulatorPhrase),'lods-nonzero-accumulator');
    requireValue(errors,metadata?.outputRoles?.some((entry) => entry.role === 'accumulator' && entry.registerName === 'rax'),'lods-output');
  }
  if (expected?.flagsBehavior?.compare) {
    requireValue(errors,metadata?.flags?.zeroCount === 'all flags preserved','compare-zero-count-flags');
    requireValue(errors,metadata?.flags?.initialZF === 'does not gate the first iteration','compare-initial-zf');
    for (const flag of ['CF','PF','AF','ZF','SF','OF']) requireValue(errors,metadata?.outputRoles?.some((entry) => entry.role === `flag-${flag}`),'compare-flag-output');
    if (expected.repeatKind === 'repe') requireValue(errors,metadata?.termination?.continuation?.includes('updated ZF == 1'),'repe-termination');
    if (expected.repeatKind === 'repne') requireValue(errors,metadata?.termination?.continuation?.includes('updated ZF == 0'),'repne-termination');
  }
  if (expected?.addressSizeBits === 32) {
    requireValue(errors,metadata?.count?.nonzeroWrite?.includes('zero-extending RCX'),'a32-count-upper-state');
    requireValue(errors,metadata?.direction?.zeroCount?.includes('full physical register'),'a32-zero-count-pointer-upper-state');
  }
  return Object.freeze({ ok:errors.length === 0, errors:Object.freeze(errors) });
}
