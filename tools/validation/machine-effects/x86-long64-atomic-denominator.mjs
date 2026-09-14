export const X86_LONG64_ATOMIC_DENOMINATOR_SCHEMA = 'x86-long64-atomic-denominator/v1';
export const X86_LONG64_ATOMIC_DENOMINATOR_ID = 'x86_64:long-64:effect-family:atomic';

const SCALAR_FAMILIES = Object.freeze({
  xchg:Object.freeze({ byte:[0x86], wide:[0x87] }),
  xadd:Object.freeze({ byte:[0x0f,0xc0], wide:[0x0f,0xc1] }),
  cmpxchg:Object.freeze({ byte:[0x0f,0xb0], wide:[0x0f,0xb1] }),
});
const WIDTHS = Object.freeze([8,16,32,64]);

function scalarOpcode(family,widthBits) { return widthBits === 8 ? SCALAR_FAMILIES[family].byte : SCALAR_FAMILIES[family].wide; }
function widthPrefix(widthBits) { return widthBits === 16 ? [0x66] : []; }
function rex(widthBits, r = 0, b = 0, force = false) {
  const value = 0x40 | (widthBits === 64 ? 0x08 : 0) | (r ? 0x04 : 0) | (b ? 0x01 : 0);
  return force || value !== 0x40 ? [value] : [];
}
function bytesFor({ family,widthBits,destinationKind,locked,variant }) {
  let reg = 1;
  let rm = 0;
  let rexR = 0;
  let rexB = 0;
  let forceRex = widthBits === 64;
  if (variant === 'extended') { rexR = 1; rexB = 1; forceRex = true; }
  if (variant === 'legacy-high-byte') { reg = 4; forceRex = false; }
  const mod = destinationKind === 'register' ? 3 : 0;
  const modrm = (mod << 6) | (reg << 3) | rm;
  return Uint8Array.from([
    ...(locked ? [0xf0] : []),
    ...widthPrefix(widthBits),
    ...rex(widthBits,rexR,rexB,forceRex),
    ...scalarOpcode(family,widthBits),
    modrm,
  ]);
}
function accumulator(widthBits) { return ({8:'al',16:'ax',32:'eax',64:'rax'})[widthBits]; }
function scalarVariants(widthBits,destinationKind) {
  const variants = ['legacy-low','extended'];
  if (widthBits === 8 && (destinationKind === 'register' || destinationKind === 'memory')) variants.push('legacy-high-byte');
  return variants;
}
function scalarCase(family,widthBits,destinationKind,locked,variant) {
  const implicitReads = family === 'cmpxchg' ? [accumulator(widthBits)] : [];
  return Object.freeze({
    id:`${family}:${widthBits}:${destinationKind}:${locked?'lock':'plain'}:${variant}`,
    family,
    widthBits,
    destinationKind,
    sourceKind:'register',
    locked,
    implicitAtomic:family === 'xchg' && destinationKind === 'memory',
    expectedAtomic:destinationKind === 'memory' && (locked || family === 'xchg'),
    expectedOrdering:destinationKind === 'memory' && (locked || family === 'xchg') ? 'seq-cst' : null,
    implicitReads:Object.freeze(implicitReads),
    implicitWrites:Object.freeze([]),
    alignmentBytes:null,
    faultClass:destinationKind === 'memory' ? 'x86-memory-read-write' : 'none',
    bytes:bytesFor({family,widthBits,destinationKind,locked,variant}),
  });
}
function wideCase(family,locked,baseVariant) {
  const is16 = family === 'cmpxchg16b';
  const rexBytes = is16 ? [0x49] : (baseVariant === 'extended' ? [0x41] : []);
  // REX.B extends ModRM.r/m from RAX to R8. CMPXCHG16B always also needs REX.W.
  const rexFinal = is16 ? [0x48 | (baseVariant === 'extended' ? 0x01 : 0)] : rexBytes;
  return Object.freeze({
    id:`${family}:${locked?'lock':'plain'}:${baseVariant}`,
    family,
    widthBits:is16 ? 128 : 64,
    destinationKind:'memory',
    sourceKind:'implicit-pair',
    locked,
    implicitAtomic:false,
    expectedAtomic:locked,
    expectedOrdering:locked ? 'seq-cst' : null,
    implicitReads:Object.freeze(is16 ? ['rax','rbx','rcx','rdx'] : ['eax','ebx','ecx','edx']),
    implicitWrites:Object.freeze(is16 ? ['rax','rdx','rflags'] : ['eax','edx','rflags']),
    expectedPair:is16 ? 'RDX:RAX' : 'EDX:EAX',
    replacementPair:is16 ? 'RCX:RBX' : 'ECX:EBX',
    alignmentBytes:is16 ? 16 : null,
    requiredFeature:is16 ? 'cx16' : 'cx8',
    faultClass:is16 ? 'x86-memory-read-write+cmpxchg16b-align16+cx16' : 'x86-memory-read-write',
    bytes:Uint8Array.from([...(locked?[0xf0]:[]),...rexFinal,0x0f,0xc7,0x08]),
  });
}

export function* x86Long64AtomicDenominatorCases() {
  for (const family of Object.keys(SCALAR_FAMILIES)) {
    for (const widthBits of WIDTHS) {
      for (const destinationKind of ['register','memory']) {
        for (const locked of (destinationKind === 'memory' ? [false,true] : [false])) {
          for (const variant of scalarVariants(widthBits,destinationKind)) yield scalarCase(family,widthBits,destinationKind,locked,variant);
        }
      }
    }
  }
  for (const family of ['cmpxchg8b','cmpxchg16b']) {
    for (const locked of [false,true]) {
      for (const baseVariant of ['legacy-low','extended']) yield wideCase(family,locked,baseVariant);
    }
  }
}

export function x86Long64AtomicNegativeEncodings() {
  const negatives = [];
  for (const family of Object.keys(SCALAR_FAMILIES)) {
    for (const widthBits of WIDTHS) {
      negatives.push(Object.freeze({
        id:`lock-${family}-register-${widthBits}`,
        bytes:bytesFor({family,widthBits,destinationKind:'register',locked:true,variant:'legacy-low'}),
        reason:'LOCK requires a memory destination',
      }));
    }
  }
  negatives.push(
    Object.freeze({ id:'cmpxchg8b-register', bytes:Uint8Array.of(0x0f,0xc7,0xc8), reason:'wide CMPXCHG requires memory /1' }),
    Object.freeze({ id:'cmpxchg16b-register', bytes:Uint8Array.of(0x48,0x0f,0xc7,0xc8), reason:'wide CMPXCHG requires memory /1' }),
  );
  return Object.freeze(negatives);
}

export function x86Long64AtomicDenominatorIdentity() {
  const cases = [...x86Long64AtomicDenominatorCases()];
  return Object.freeze({
    schemaVersion:X86_LONG64_ATOMIC_DENOMINATOR_SCHEMA,
    denominatorId:X86_LONG64_ATOMIC_DENOMINATOR_ID,
    semanticCaseCount:cases.length,
    familyCount:5,
    scalarWidths:Object.freeze([...WIDTHS]),
    destinationKinds:Object.freeze(['register','memory']),
    lockClasses:Object.freeze(['plain','explicit-lock','implicit-memory-xchg']),
    wideFamilies:Object.freeze(['cmpxchg8b','cmpxchg16b']),
    oracleIds:Object.freeze([
      'intel-sdm-vol2-cmpxchg-xadd-xchg-current',
      'intel-sdm-vol3-locked-instruction-ordering-current',
      'amd64-vol3-general-purpose-programming-current',
      'deployed-capstone-5-x86-long64-structured-detail',
    ]),
  });
}
