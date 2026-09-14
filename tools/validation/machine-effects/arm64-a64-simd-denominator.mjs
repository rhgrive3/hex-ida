// Independent finite denominator for the A64 fixed-width Advanced SIMD effect family.
// Keep this specification independent from js/targets/architecture/arm64/effects/simd.js:
// the production registry is a subject under test, never an authority for this list.

import { createHash } from 'node:crypto';

import { ARM64_A64_DECODER_IDENTITY_LOCK } from './arm64-a64-decoder-denominator.mjs';

export const ARM64_A64_SIMD_DENOMINATOR_VERSION = 'arm64-a64-simd-denominator-v1';
export const ARM64_A64_SIMD_DENOMINATOR_SCHEMA = 'arm64-a64-simd-denominator/v1';
export const ARM64_A64_SIMD_DENOMINATOR_ID = 'arm64:a64:advanced-simd-encoding-discriminators:v1';
export const ARM64_A64_SIMD_LOCKED_SCOPE_ID = 'arm64:a64:advanced-simd-fixed-width-registry-scope:v1';

// Locked corpus identity. The case list is the denominator; pinning its digest
// here means a silently shrunk or reordered corpus fails the dependency proof
// instead of quietly proving a smaller claim.
export const ARM64_A64_SIMD_LOCKED_CASE_COUNT = 891;
export const ARM64_A64_SIMD_LOCKED_CORPUS_SHA256 = '7fe74945fe34e0f0c1f967297d53e25323d03bd446d701598211f15f49bedd4b';

export const ARM64_A64_SIMD_ORACLE_IDS = Object.freeze([
  'arm-a64-advanced-simd-encoding-tables',
  'llvm-mc-aarch64-advanced-simd',
  'deployed-capstone-arm64-a64',
]);

export const ARM64_A64_SIMD_MNEMONIC_DENOMINATOR = Object.freeze([
  'dup','ins','umov','smov','mov','movi','mvni',
  'tbl','tbx','zip1','zip2','uzp1','uzp2','trn1','trn2','ext','rev64','rev64_v',
  'addv','uaddlv','saddlv','smaxv','sminv','umaxv','uminv',
  'xtn','xtn2','sqxtn','sqxtn2','uqxtn','uqxtn2','sqxtun','sqxtun2',
  'add','sub','mul','mla','mls','abs','neg','and','orr','orr_v','eor','bic','orn','not','mvn',
  'cmeq','cmge','cmgt','cmhi','cmhs','cmtst','smax','smin','umax','umin','addp',
  'smaxp','sminp','umaxp','uminp','shl','sshl','ushl','sshr','ushr','sli','sri',
  'sqadd','uqadd','sqsub','uqsub','suqadd',
  'fadd','fsub','fmul','fdiv','fmla','fmls','fabs','fneg','fsqrt','fmax','fmin','fmaxnm','fminnm',
  'fcmeq','fcmge','fcmgt','facge','facgt','frecpe','frecps','frsqrte','frsqrts',
  'fcvtzs','fcvtzu','scvtf','ucvtf','frinta','frintm','frintn','frintp','frintx','frinti','frintz',
]);

// Internal decoder aliases that have no distinct architectural assembler spelling.
// INS/UMOV assembler aliases are represented directly by assembly cases because Capstone
// canonicalization is encoding-dependent (for example UMOV B/H stays UMOV, S/D becomes MOV).
export const ARM64_A64_SIMD_ALIAS_BINDINGS = Object.freeze([
  Object.freeze({ registryMnemonic:'orr_v', canonicalMnemonic:'orr', form:'vector-register' }),
  Object.freeze({ registryMnemonic:'rev64_v', canonicalMnemonic:'rev64', form:'vector-register' }),
  Object.freeze({ registryMnemonic:'not', canonicalMnemonic:'mvn', form:'vector-register' }),
]);

const ARR_INT_FULL = Object.freeze(['8b','16b','4h','8h','2s','4s','2d']);
const ARR_INT_NO_D = Object.freeze(['8b','16b','4h','8h','2s','4s']);
const ARR_BITWISE = Object.freeze(['8b','16b']);
const ARR_REV64 = Object.freeze(['8b','16b','4h','8h','2s','4s']);
const ARR_FP = Object.freeze(['4h','8h','2s','4s','2d']);
const ARR_MUL_ELEM = Object.freeze(['4h','8h','2s','4s']);

const elementBits = (arr) => ({ b:8, h:16, s:32, d:64 })[arr.at(-1)];
const laneCount = (arr) => Number.parseInt(arr, 10);
const scalarName = (bits, reg = 0) => `${bits === 8 ? 'b' : bits === 16 ? 'h' : bits === 32 ? 's' : 'd'}${reg}`;
const vec = (reg, arr) => `v${reg}.${arr}`;
const lane = (reg, arr, index) => `v${reg}.${arr.at(-1)}[${index}]`;

function makeCases() {
  const cases = [];
  let ordinal = 0;
  const add = (registryMnemonic, form, assembly, expectedMnemonic = registryMnemonic) => {
    const id = `${registryMnemonic}:${form}:${String(ordinal++).padStart(4,'0')}`;
    cases.push(Object.freeze({ id, registryMnemonic, form, assembly, expectedMnemonic }));
  };
  const ternary = (mnemonics, arrangements, form = 'vector-register') => {
    for (const mnemonic of mnemonics) for (const arr of arrangements) {
      add(mnemonic, `${form}:${arr}`, `${mnemonic} ${vec(0,arr)}, ${vec(1,arr)}, ${vec(2,arr)}`);
    }
  };
  const unary = (mnemonics, arrangements, form = 'vector-register') => {
    for (const mnemonic of mnemonics) for (const arr of arrangements) {
      add(mnemonic, `${form}:${arr}`, `${mnemonic} ${vec(0,arr)}, ${vec(1,arr)}`);
    }
  };

  ternary(['add','sub','cmhi','cmhs','cmtst','addp','sshl','ushl','sqadd','uqadd','sqsub','uqsub'], ARR_INT_FULL);
  unary(['abs','neg'], ARR_INT_FULL);
  ternary(['smax','smin','umax','umin','smaxp','sminp','umaxp','uminp'], ARR_INT_NO_D);
  ternary(['and','orr','eor','bic','orn'], ARR_BITWISE);
  for (const arr of ARR_BITWISE) add('not', `vector-register:${arr}`, `not ${vec(0,arr)}, ${vec(1,arr)}`, 'mvn');
  unary(['mvn'], ARR_BITWISE);

  for (const mnemonic of ['cmeq','cmge','cmgt']) {
    ternary([mnemonic], ARR_INT_FULL, 'vector-register');
    for (const arr of ARR_INT_FULL) add(mnemonic, `vector-zero:${arr}`, `${mnemonic} ${vec(0,arr)}, ${vec(1,arr)}, #0`);
  }

  for (const mnemonic of ['shl','sshr','ushr','sli','sri']) for (const arr of ARR_INT_FULL) {
    const bits = elementBits(arr);
    const min = ['sshr','ushr','sri'].includes(mnemonic) ? 1 : 0;
    const max = ['sshr','ushr','sri'].includes(mnemonic) ? bits : bits - 1;
    for (const amount of new Set([min,max])) add(mnemonic, `vector-immediate:${arr}:shift-${amount}`, `${mnemonic} ${vec(0,arr)}, ${vec(1,arr)}, #${amount}`);
  }

  for (const mnemonic of ['mul','mla','mls']) {
    ternary([mnemonic], ARR_INT_NO_D);
    for (const arr of ARR_MUL_ELEM) {
      const size = arr.at(-1);
      const sourceRegister = size === 'h' ? 15 : 3;
      const maxLane = size === 'h' ? 7 : 3;
      add(mnemonic, `by-element:${arr}:lane-0`, `${mnemonic} ${vec(0,arr)}, ${vec(1,arr)}, v${sourceRegister}.${size}[0]`);
      add(mnemonic, `by-element:${arr}:lane-max`, `${mnemonic} ${vec(0,arr)}, ${vec(1,arr)}, v${sourceRegister}.${size}[${maxLane}]`);
    }
  }
  unary(['suqadd'], ARR_INT_FULL, 'destructive-vector-register');

  for (const arr of ARR_BITWISE) add('movi', `modified-immediate:${arr}`, `movi ${vec(0,arr)}, #0x12`);
  for (const arr of ['4h','8h']) {
    add('movi', `modified-immediate:${arr}:plain`, `movi ${vec(0,arr)}, #0x12`);
    add('movi', `modified-immediate:${arr}:lsl8`, `movi ${vec(0,arr)}, #0x12, lsl #8`);
    add('mvni', `modified-immediate:${arr}:plain`, `mvni ${vec(0,arr)}, #0x12`);
    add('mvni', `modified-immediate:${arr}:lsl8`, `mvni ${vec(0,arr)}, #0x12, lsl #8`);
  }
  for (const arr of ['2s','4s']) for (const mnemonic of ['movi','mvni']) {
    add(mnemonic, `modified-immediate:${arr}:plain`, `${mnemonic} ${vec(0,arr)}, #0x12`);
    for (const amount of [8,16,24]) add(mnemonic, `modified-immediate:${arr}:lsl${amount}`, `${mnemonic} ${vec(0,arr)}, #0x12, lsl #${amount}`);
    for (const amount of [8,16]) add(mnemonic, `modified-immediate:${arr}:msl${amount}`, `${mnemonic} ${vec(0,arr)}, #0x12, msl #${amount}`);
  }
  add('movi', 'modified-immediate:2d:byte-mask', 'movi v0.2d, #0xff00ff00ff00ff00');
  for (const mnemonic of ['orr','bic']) for (const arr of ['4h','8h','2s','4s']) {
    add(mnemonic, `logical-immediate:${arr}:plain`, `${mnemonic} ${vec(0,arr)}, #0x12`);
    const shifts = elementBits(arr) === 16 ? [8] : [8,16,24];
    for (const amount of shifts) add(mnemonic, `logical-immediate:${arr}:lsl${amount}`, `${mnemonic} ${vec(0,arr)}, #0x12, lsl #${amount}`);
  }

  const reductionMap = Object.freeze({
    addv:{'8b':8,'16b':8,'4h':16,'8h':16,'4s':32},
    smaxv:{'8b':8,'16b':8,'4h':16,'8h':16,'4s':32},
    sminv:{'8b':8,'16b':8,'4h':16,'8h':16,'4s':32},
    umaxv:{'8b':8,'16b':8,'4h':16,'8h':16,'4s':32},
    uminv:{'8b':8,'16b':8,'4h':16,'8h':16,'4s':32},
    uaddlv:{'8b':16,'16b':16,'4h':32,'8h':32,'4s':64},
    saddlv:{'8b':16,'16b':16,'4h':32,'8h':32,'4s':64},
  });
  for (const [mnemonic, forms] of Object.entries(reductionMap)) for (const [arr,bits] of Object.entries(forms)) {
    add(mnemonic, `reduction:${arr}->${bits}`, `${mnemonic} ${scalarName(bits)}, ${vec(1,arr)}`);
  }

  const narrowLow = Object.freeze({'8b':'8h','4h':'4s','2s':'2d'});
  const narrowHigh = Object.freeze({'16b':'8h','8h':'4s','4s':'2d'});
  for (const mnemonic of ['xtn','sqxtn','uqxtn','sqxtun']) for (const [dst,src] of Object.entries(narrowLow)) add(mnemonic, `narrow:${src}->${dst}`, `${mnemonic} ${vec(0,dst)}, ${vec(1,src)}`);
  for (const mnemonic of ['xtn2','sqxtn2','uqxtn2','sqxtun2']) for (const [dst,src] of Object.entries(narrowHigh)) add(mnemonic, `narrow-high:${src}->${dst}`, `${mnemonic} ${vec(0,dst)}, ${vec(1,src)}`);

  for (const mnemonic of ['zip1','zip2','uzp1','uzp2','trn1','trn2']) ternary([mnemonic], ARR_INT_FULL);
  unary(['rev64'], ARR_REV64);
  for (const arr of ARR_BITWISE) for (const offset of [0,laneCount(arr)-1]) add('ext', `extract:${arr}:offset-${offset}`, `ext ${vec(0,arr)}, ${vec(1,arr)}, ${vec(2,arr)}, #${offset}`);
  for (const mnemonic of ['tbl','tbx']) for (const arr of ARR_BITWISE) {
    for (const length of [1,2,3,4]) {
      const regs = Array.from({length}, (_,index) => `v${4+index}.16b`).join(', ');
      add(mnemonic, `table:${arr}:list-${length}`, `${mnemonic} ${vec(0,arr)}, { ${regs} }, ${vec(1,arr)}`);
    }
    add(mnemonic, `table:${arr}:wrap-list`, `${mnemonic} ${vec(0,arr)}, { v30.16b, v31.16b, v0.16b }, ${vec(1,arr)}`);
  }

  ternary(['fadd','fsub','fdiv','fmax','fmin','fmaxnm','fminnm','frecps','frsqrts'], ARR_FP, 'fp-vector-register');
  unary(['fabs','fneg','fsqrt','frecpe','frsqrte','frinta','frintm','frintn','frintp','frintx','frinti','frintz'], ARR_FP, 'fp-vector-register');
  for (const mnemonic of ['fmul','fmla','fmls']) {
    ternary([mnemonic], ARR_FP, 'fp-vector-register');
    for (const arr of ARR_FP) {
      const size = arr.at(-1);
      const sourceRegister = size === 'h' ? 15 : 3;
      const maxLane = size === 'h' ? 7 : size === 's' ? 3 : 1;
      add(mnemonic, `fp-by-element:${arr}:lane-0`, `${mnemonic} ${vec(0,arr)}, ${vec(1,arr)}, v${sourceRegister}.${size}[0]`);
      add(mnemonic, `fp-by-element:${arr}:lane-max`, `${mnemonic} ${vec(0,arr)}, ${vec(1,arr)}, v${sourceRegister}.${size}[${maxLane}]`);
    }
  }
  for (const mnemonic of ['fcmeq','fcmge','fcmgt']) for (const arr of ARR_FP) {
    add(mnemonic, `fp-compare-register:${arr}`, `${mnemonic} ${vec(0,arr)}, ${vec(1,arr)}, ${vec(2,arr)}`);
    add(mnemonic, `fp-compare-zero:${arr}`, `${mnemonic} ${vec(0,arr)}, ${vec(1,arr)}, #0.0`);
  }
  ternary(['facge','facgt'], ARR_FP, 'fp-absolute-compare');
  for (const mnemonic of ['fcvtzs','fcvtzu','scvtf','ucvtf']) for (const arr of ARR_FP) {
    add(mnemonic, `conversion:${arr}`, `${mnemonic} ${vec(0,arr)}, ${vec(1,arr)}`);
    for (const scale of new Set([1,elementBits(arr)])) add(mnemonic, `fixed-conversion:${arr}:scale-${scale}`, `${mnemonic} ${vec(0,arr)}, ${vec(1,arr)}, #${scale}`);
  }

  // Fixed-width Advanced SIMD scalar forms. These share mnemonics with GP or
  // scalar-FP instructions, so the structured register class/width is part of the
  // denominator rather than treating the mnemonic as ownership evidence.
  for (const mnemonic of ['add','sub','cmhi','cmhs','cmtst','sshl','ushl']) {
    add(mnemonic, 'scalar-d-register', `${mnemonic} d0, d1, d2`);
  }
  for (const mnemonic of ['abs','neg']) add(mnemonic, 'scalar-d-register', `${mnemonic} d0, d1`);
  for (const mnemonic of ['cmeq','cmge','cmgt']) {
    add(mnemonic, 'scalar-d-register', `${mnemonic} d0, d1, d2`);
    add(mnemonic, 'scalar-d-zero', `${mnemonic} d0, d1, #0`);
  }
  for (const mnemonic of ['sqadd','uqadd','sqsub','uqsub']) for (const size of ['b','h','s','d']) {
    add(mnemonic, `scalar-saturating:${size}`, `${mnemonic} ${size}0, ${size}1, ${size}2`);
  }
  for (const size of ['b','h','s','d']) add('suqadd', `scalar-saturating:${size}`, `suqadd ${size}0, ${size}1`);
  for (const mnemonic of ['shl','sshr','ushr','sli','sri']) {
    const min = ['sshr','ushr','sri'].includes(mnemonic) ? 1 : 0;
    const max = ['sshr','ushr','sri'].includes(mnemonic) ? 64 : 63;
    for (const amount of new Set([min,max])) add(mnemonic, `scalar-d-shift:${amount}`, `${mnemonic} d0, d1, #${amount}`);
  }
  add('addp', 'scalar-pairwise:2d-to-d', 'addp d0, v1.2d');
  for (const mnemonic of ['sqxtn','uqxtn','sqxtun']) for (const [dst,src] of [['b','h'],['h','s'],['s','d']]) {
    add(mnemonic, `scalar-narrow:${src}->${dst}`, `${mnemonic} ${dst}0, ${src}1`);
  }
  for (const mnemonic of ['fcmeq','fcmge','fcmgt','facge','facgt']) for (const size of ['h','s','d']) {
    add(mnemonic, `scalar-fp-compare:${size}`, `${mnemonic} ${size}0, ${size}1, ${size}2`);
    if (!['facge','facgt'].includes(mnemonic)) add(mnemonic, `scalar-fp-zero:${size}`, `${mnemonic} ${size}0, ${size}1, #0.0`);
  }

  // Register/lane transfer discriminator. The `ins`/`umov` spellings intentionally
  // exercise assembler aliases even when the disassembler canonicalizes them to MOV.
  for (const arr of ARR_INT_FULL) {
    const bits = elementBits(arr);
    const maxLane = 128 / bits - 1;
    const gpName = bits === 64 ? 'x3' : 'w3';
    add('dup', `gp-to-vector:${arr}`, `dup ${vec(0,arr)}, ${gpName}`);
    add('dup', `lane-to-vector:${arr}:max`, `dup ${vec(0,arr)}, ${lane(2,arr,maxLane)}`);
  }
  for (const size of ['b','h','s','d']) {
    const bits = ({b:8,h:16,s:32,d:64})[size];
    const arr = `${128/bits}${size}`;
    const maxLane = 128 / bits - 1;
    const gpName = bits === 64 ? 'x3' : 'w3';
    add('ins', `gp-to-lane:${size}`, `ins v0.${size}[${maxLane}], ${gpName}`, 'mov');
    add('ins', `lane-to-lane:${size}`, `ins v0.${size}[0], v2.${size}[${maxLane}]`, 'mov');
    add('mov', `gp-to-lane:${size}`, `mov v0.${size}[${maxLane}], ${gpName}`);
    add('mov', `lane-to-lane:${size}`, `mov v0.${size}[0], v2.${size}[${maxLane}]`);
  }
  for (const [size,bits] of [['b',8],['h',16],['s',32]]) {
    const maxLane = 128 / bits - 1;
    add('umov', `lane-to-w:${size}`, `umov w0, v2.${size}[${maxLane}]`, bits < 32 ? 'umov' : 'mov');
    if (bits === 32) add('mov', `lane-to-w:${size}`, `mov w0, v2.${size}[${maxLane}]`);
  }
  add('umov', 'lane-to-x:d', 'umov x0, v2.d[1]', 'mov');
  add('mov', 'lane-to-x:d', 'mov x0, v2.d[1]');
  for (const [size,bits] of [['b',8],['h',16]]) {
    const maxLane = 128 / bits - 1;
    add('smov', `signed-lane-to-w:${size}`, `smov w0, v2.${size}[${maxLane}]`);
  }
  for (const [size,bits] of [['b',8],['h',16],['s',32]]) {
    const maxLane = 128 / bits - 1;
    add('smov', `signed-lane-to-x:${size}`, `smov x0, v2.${size}[${maxLane}]`);
  }
  for (const arr of ARR_BITWISE) add('mov', `vector-copy:${arr}`, `mov ${vec(0,arr)}, ${vec(1,arr)}`);
  add('dup', 'gp-zero-register:w', 'dup v31.4s, wzr');
  add('dup', 'gp-zero-register:x', 'dup v31.2d, xzr');
  add('ins', 'gp-zero-register:w', 'ins v31.s[3], wzr', 'mov');
  add('ins', 'gp-zero-register:x', 'ins v31.d[1], xzr', 'mov');
  add('umov', 'zero-destination:w', 'umov wzr, v31.s[3]', 'mov');
  add('umov', 'zero-destination:x', 'umov xzr, v31.d[1]', 'mov');
  add('smov', 'zero-destination:w', 'smov wzr, v31.h[7]');
  add('smov', 'zero-destination:x', 'smov xzr, v31.s[3]');

  return Object.freeze(cases);
}

export const ARM64_A64_SIMD_ASSEMBLY_CASES = makeCases();

export function validateArm64A64SimdDenominator() {
  const ids = new Set();
  const represented = new Set(ARM64_A64_SIMD_ALIAS_BINDINGS.map((entry) => entry.registryMnemonic));
  const forms = new Set();
  for (const entry of ARM64_A64_SIMD_ASSEMBLY_CASES) {
    if (!entry.id || !entry.registryMnemonic || !entry.form || !entry.assembly || !entry.expectedMnemonic) throw new Error('arm64-a64-simd-denominator-entry-incomplete');
    if (ids.has(entry.id)) throw new Error(`arm64-a64-simd-denominator-duplicate-id:${entry.id}`);
    ids.add(entry.id);
    represented.add(entry.registryMnemonic);
    forms.add(`${entry.registryMnemonic}:${entry.form}`);
  }
  const denominator = new Set(ARM64_A64_SIMD_MNEMONIC_DENOMINATOR);
  if (denominator.size !== ARM64_A64_SIMD_MNEMONIC_DENOMINATOR.length) throw new Error('arm64-a64-simd-denominator-duplicate-mnemonic');
  const missing = [...denominator].filter((mnemonic) => !represented.has(mnemonic));
  const extra = [...represented].filter((mnemonic) => !denominator.has(mnemonic));
  if (missing.length || extra.length) throw new Error(`arm64-a64-simd-denominator-coverage-drift:missing=${missing.join(',')}:extra=${extra.join(',')}`);
  return Object.freeze({
    version:ARM64_A64_SIMD_DENOMINATOR_VERSION,
    schemaVersion:ARM64_A64_SIMD_DENOMINATOR_SCHEMA,
    denominatorId:ARM64_A64_SIMD_DENOMINATOR_ID,
    profileId:'arm64:a64',
    mnemonicCount:denominator.size,
    caseCount:ARM64_A64_SIMD_ASSEMBLY_CASES.length,
    formCount:forms.size,
    aliasBindingCount:ARM64_A64_SIMD_ALIAS_BINDINGS.length,
    corpusSha256:arm64A64SimdCorpusSha256(),
    oracleIds:ARM64_A64_SIMD_ORACLE_IDS,
  });
}

export function arm64A64SimdCorpusSha256() {
  const hash = createHash('sha256');
  for (const entry of [...ARM64_A64_SIMD_ASSEMBLY_CASES].sort((a, b) => a.id.localeCompare(b.id))) {
    hash.update(`${entry.id}\t${entry.registryMnemonic}\t${entry.form}\t${entry.assembly}\t${entry.expectedMnemonic}\n`);
  }
  return hash.digest('hex');
}

// Dependency contract consumed by the A64 decoder ownership denominator. The
// decoder denominator must not read this module's internals: it only accepts a
// fixed-shape proof whose authority is independent of the production registry.
export function arm64A64SimdDecoderDependencyProof() {
  const denominator = validateArm64A64SimdDenominator();
  return Object.freeze({
    schemaVersion:'arm64-a64-decoder-family-proof/v2',
    canonicalFamily:'simd',
    profileId:'arm64:a64',
    coverageState:'exact',
    decoderProvider:'capstone/backend',
    decoderIdentityId:ARM64_A64_DECODER_IDENTITY_LOCK.identityId,
    denominatorId:ARM64_A64_SIMD_DENOMINATOR_ID,
    denominatorAuthority:'independent-arm-advanced-simd-encoding-tables-plus-llvm-mc',
    independentAuthority:true,
    oracleIds:ARM64_A64_SIMD_ORACLE_IDS,
    lockedScopeId:ARM64_A64_SIMD_LOCKED_SCOPE_ID,
    encodingCaseCount:denominator.caseCount,
    lockedEncodingCaseCount:ARM64_A64_SIMD_LOCKED_CASE_COUNT,
    lockedCorpusSha256:ARM64_A64_SIMD_LOCKED_CORPUS_SHA256,
    observedCorpusSha256:denominator.corpusSha256,
    validEncodingOwnershipProof:true,
    fallbackNegativeProof:true,
    scopeShrinkGuard:true,
    corpusShrinkGuard:true,
  });
}
