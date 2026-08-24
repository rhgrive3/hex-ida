export const ARM64_A64_MEMORY_DENOMINATOR_SCHEMA = 'arm64-a64-memory-denominator/v1';
export const ARM64_A64_MEMORY_DENOMINATOR_ID = 'arm64:a64:memory-encoding-discriminators:v1';

const family = (id, discriminators) => Object.freeze({ id, discriminators:Object.freeze(discriminators) });
export const ARM64_A64_MEMORY_ENCODING_FAMILIES = Object.freeze([
  family('single-load-store', ['mnemonic','width','scaled-imm12','register-offset','pre-index','post-index','writeback','fault']),
  family('single-unscaled-unprivileged', ['mnemonic','width','signed-imm9','privilege','fault']),
  family('pair-load-store', ['mnemonic','width','signed-scaled-imm7','pre-index','post-index','writeback','fault']),
  family('literal-load', ['mnemonic','width','signedness','pc-relative','fault']),
  family('acquire-release', ['mnemonic','width','ordering','atomic','fault']),
  family('exclusive', ['mnemonic','width','ordering','monitor-state','fault']),
  family('lse-atomic', ['mnemonic','width','ordering','conditional-write','fault']),
  family('barrier-exclusive-clear', ['mnemonic','ordering','scope','hidden-state']),
  family('prefetch-partial', ['mnemonic','implementation-defined','fail-closed']),
]);

const NON_ATOMIC_EXACT = Object.freeze([
  'ldr','ldrb','ldrh','ldrsb','ldrsh','ldrsw','ldur','ldurb','ldurh','ldursb','ldursh','ldursw','ldp','ldpsw','ldnp','ldar','ldarb','ldarh','ldtr',
  'str','strb','strh','stur','sturb','sturh','stp','stnp','stlr','stlrb','stlrh','sttr',
]);
const ORDER_SUFFIXES = Object.freeze([
  Object.freeze({ suffix:'', ordering:'relaxed', read:'relaxed', write:'relaxed' }),
  Object.freeze({ suffix:'a', ordering:'acquire', read:'acquire', write:'relaxed' }),
  Object.freeze({ suffix:'l', ordering:'release', read:'relaxed', write:'release' }),
  Object.freeze({ suffix:'al', ordering:'acq-rel', read:'acquire', write:'release' }),
]);
const SIZE_FORMS = Object.freeze([
  Object.freeze({ suffix:'b', widths:Object.freeze([8]), reg:'w' }),
  Object.freeze({ suffix:'h', widths:Object.freeze([16]), reg:'w' }),
  Object.freeze({ suffix:'', widths:Object.freeze([32,64]), reg:null }),
]);

function orderedSizedMnemonics(base) {
  return ORDER_SUFFIXES.flatMap(({ suffix:order }) => SIZE_FORMS.map(({ suffix:size }) => `${base}${order}${size}`));
}
function exclusiveSizedMnemonics(base) { return SIZE_FORMS.map(({ suffix }) => `${base}${suffix}`); }

const ATOMIC_EXACT = Object.freeze([
  ...exclusiveSizedMnemonics('ldxr'), ...exclusiveSizedMnemonics('ldaxr'),
  ...exclusiveSizedMnemonics('stxr'), ...exclusiveSizedMnemonics('stlxr'),
  ...orderedSizedMnemonics('cas'), ...orderedSizedMnemonics('swp'),
  ...orderedSizedMnemonics('ldadd'), ...orderedSizedMnemonics('ldset'),
  ...orderedSizedMnemonics('ldclr'), ...orderedSizedMnemonics('ldeor'),
  'dmb','dsb','isb','clrex',
]);

export const ARM64_A64_MEMORY_EXACT_MNEMONICS = Object.freeze([...NON_ATOMIC_EXACT, ...ATOMIC_EXACT]);
export const ARM64_A64_MEMORY_PARTIAL_MNEMONICS = Object.freeze(['prfm']);

const item = (id, familyId, asm, mnemonic, expected = {}) => Object.freeze({
  id, familyId, asm, mnemonic, completeness:expected.completeness || 'exact', ...expected,
});

const CANONICAL_NON_ATOMIC = Object.freeze([
  ['ldr','ldr w0, [x1]','single-load-store',32],
  ['ldrb','ldrb w0, [x1]','single-load-store',8],
  ['ldrh','ldrh w0, [x1]','single-load-store',16],
  ['ldrsb','ldrsb x0, [x1]','single-load-store',8],
  ['ldrsh','ldrsh x0, [x1]','single-load-store',16],
  ['ldrsw','ldrsw x0, [x1]','single-load-store',32],
  ['ldur','ldur x0, [x1, #-1]','single-unscaled-unprivileged',64],
  ['ldurb','ldurb w0, [x1, #-1]','single-unscaled-unprivileged',8],
  ['ldurh','ldurh w0, [x1, #-1]','single-unscaled-unprivileged',16],
  ['ldursb','ldursb x0, [x1, #-1]','single-unscaled-unprivileged',8],
  ['ldursh','ldursh x0, [x1, #-1]','single-unscaled-unprivileged',16],
  ['ldursw','ldursw x0, [x1, #-1]','single-unscaled-unprivileged',32],
  ['ldp','ldp x0, x2, [x1]','pair-load-store',64],
  ['ldpsw','ldpsw x0, x2, [x1]','pair-load-store',32],
  ['ldnp','ldnp x0, x2, [x1]','pair-load-store',64],
  ['ldar','ldar x0, [x1]','acquire-release',64,'acquire'],
  ['ldarb','ldarb w0, [x1]','acquire-release',8,'acquire'],
  ['ldarh','ldarh w0, [x1]','acquire-release',16,'acquire'],
  ['ldtr','ldtr x0, [x1, #-1]','single-unscaled-unprivileged',64],
  ['str','str w0, [x1]','single-load-store',32],
  ['strb','strb w0, [x1]','single-load-store',8],
  ['strh','strh w0, [x1]','single-load-store',16],
  ['stur','stur x0, [x1, #-1]','single-unscaled-unprivileged',64],
  ['sturb','sturb w0, [x1, #-1]','single-unscaled-unprivileged',8],
  ['sturh','sturh w0, [x1, #-1]','single-unscaled-unprivileged',16],
  ['stp','stp x0, x2, [x1]','pair-load-store',64],
  ['stnp','stnp x0, x2, [x1]','pair-load-store',64],
  ['stlr','stlr x0, [x1]','acquire-release',64,'release'],
  ['stlrb','stlrb w0, [x1]','acquire-release',8,'release'],
  ['stlrh','stlrh w0, [x1]','acquire-release',16,'release'],
  ['sttr','sttr x0, [x1, #-1]','single-unscaled-unprivileged',64],
]);

function* atomicCases() {
  for (const acquire of [false,true]) {
    const base = acquire ? 'ldaxr' : 'ldxr';
    for (const size of SIZE_FORMS) for (const widthBits of size.widths) {
      const mnemonic = `${base}${size.suffix}`;
      const reg = widthBits === 64 ? 'x0' : 'w0';
      yield item(`exclusive-load:${mnemonic}:${widthBits}`, 'exclusive', `${mnemonic} ${reg}, [x1]`, mnemonic, {
        completeness:'exact-with-intrinsic', widthBits, ordering:acquire ? 'acquire' : 'relaxed', faultKinds:widthBits > 8 ? ['data-abort','alignment-fault'] : ['data-abort'],
      });
    }
  }
  for (const release of [false,true]) {
    const base = release ? 'stlxr' : 'stxr';
    for (const size of SIZE_FORMS) for (const widthBits of size.widths) {
      const mnemonic = `${base}${size.suffix}`;
      const data = widthBits === 64 ? 'x2' : 'w2';
      yield item(`exclusive-store:${mnemonic}:${widthBits}`, 'exclusive', `${mnemonic} w0, ${data}, [x1]`, mnemonic, {
        completeness:'exact-with-intrinsic', widthBits, ordering:release ? 'release' : 'relaxed', faultKinds:widthBits > 8 ? ['data-abort','alignment-fault'] : ['data-abort'],
      });
    }
  }
  for (const base of ['cas','swp','ldadd','ldset','ldclr','ldeor']) for (const order of ORDER_SUFFIXES) for (const size of SIZE_FORMS) for (const widthBits of size.widths) {
    const mnemonic = `${base}${order.suffix}${size.suffix}`;
    const regPrefix = widthBits === 64 ? 'x' : 'w';
    yield item(`lse:${mnemonic}:${widthBits}`, 'lse-atomic', `${mnemonic} ${regPrefix}0, ${regPrefix}2, [x1]`, mnemonic, {
      completeness:'exact-with-intrinsic', widthBits, ordering:order.ordering, readOrdering:order.read, writeOrdering:order.write,
      faultKinds:widthBits > 8 ? ['data-abort','alignment-fault'] : ['data-abort'], operation:base === 'cas' ? 'compare-swap' : base,
    });
  }
}

export function* arm64A64MemoryEncodingCases() {
  for (const [mnemonic, asm, familyId, widthBits, ordering] of CANONICAL_NON_ATOMIC) {
    yield item(`canonical:${mnemonic}`, familyId, asm, mnemonic, {
      widthBits, ...(ordering ? { ordering } : {}), faultKinds:familyId === 'acquire-release' && widthBits > 8 ? ['data-abort','alignment-fault'] : ['data-abort'],
    });
  }

  for (const [name, asm, widthBits] of [
    ['b','ldr b0, [x1]',8],['h','ldr h0, [x1]',16],['s','ldr s0, [x1]',32],['d','ldr d0, [x1]',64],['q','ldr q0, [x1]',128],['x','ldr x0, [x1]',64],
    ['store-q','str q0, [x1]',128],
  ]) yield item(`width:${name}`, 'single-load-store', asm, asm.startsWith('str') ? 'str' : 'ldr', { widthBits, faultKinds:['data-abort'] });

  for (const [id, asm, mode, writeback] of [
    ['scaled-max','ldr x0, [x1, #32760]','offset',false],
    ['pre-min','ldr x0, [x1, #-256]!','pre',true],
    ['post-max','ldr x0, [x1], #255','post',true],
    ['register-x','ldr x0, [x1, x2, lsl #3]','offset',false],
    ['register-w','ldr x0, [x1, w2, uxtw #3]','offset',false],
  ]) yield item(`address:${id}`, 'single-load-store', asm, 'ldr', { widthBits:64, addressingMode:mode, writeback, faultKinds:['data-abort'] });

  for (const [id, asm, widthBits] of [
    ['w','ldp w0, w2, [x1]',32],['x','ldp x0, x2, [x1]',64],['s','ldp s0, s2, [x1]',32],['d','ldp d0, d2, [x1]',64],['q','ldp q0, q2, [x1]',128],
  ]) yield item(`pair-width:${id}`, 'pair-load-store', asm, 'ldp', { widthBits, addressingMode:'offset', faultKinds:['data-abort'] });
  for (const [id, asm, mode] of [
    ['pre-min','ldp x0, x2, [x1, #-512]!','pre'],['post-max','ldp x0, x2, [x1], #504','post'],
  ]) yield item(`pair-address:${id}`, 'pair-load-store', asm, 'ldp', { widthBits:64, addressingMode:mode, writeback:true, faultKinds:['data-abort'] });

  for (const [id, asm, mnemonic, widthBits] of [
    ['w','ldr w0, .','ldr',32],['x','ldr x0, .','ldr',64],['s','ldr s0, .','ldr',32],['d','ldr d0, .','ldr',64],['q','ldr q0, .','ldr',128],['sw','ldrsw x0, .','ldrsw',32],
  ]) yield item(`literal:${id}`, 'literal-load', asm, mnemonic, { widthBits, literal:true, faultKinds:['data-abort'] });

  yield* atomicCases();

  for (const mnemonic of ['dmb','dsb']) for (const option of ['sy','st','ld','ish','ishst','ishld','nsh','nshst','nshld','osh','oshst','oshld']) {
    yield item(`barrier:${mnemonic}:${option}`, 'barrier-exclusive-clear', `${mnemonic} ${option}`, mnemonic, { ordering:'barrier', barrierOption:option, faultKinds:[] });
  }
  yield item('barrier:isb:sy', 'barrier-exclusive-clear', 'isb sy', 'isb', { barrierOption:'sy', faultKinds:[] });
  for (const immediate of [0,15]) yield item(`clrex:${immediate}`, 'barrier-exclusive-clear', `clrex #${immediate}`, 'clrex', { completeness:'exact-with-intrinsic', clrexImmediate:immediate, faultKinds:[] });

  yield item('fault:sp-single', 'single-load-store', 'ldr x0, [sp]', 'ldr', { widthBits:64, addressingMode:'offset', faultKinds:['stack-pointer-alignment-fault','data-abort'], tagChecked:false });
  yield item('fault:sp-exclusive', 'exclusive', 'ldxr x0, [sp]', 'ldxr', { completeness:'exact-with-intrinsic', widthBits:64, ordering:'relaxed', faultKinds:['stack-pointer-alignment-fault','data-abort','alignment-fault'], tagChecked:false });

  yield item('partial:prfm', 'prefetch-partial', 'prfm pldl1keep, [x1]', 'prfm', { completeness:'partial', faultKinds:[] });
}

export function validateArm64A64MemoryDenominator() {
  const familyIds = ARM64_A64_MEMORY_ENCODING_FAMILIES.map(({ id }) => id);
  if (new Set(familyIds).size !== familyIds.length) throw new Error('arm64-memory-denominator-family-duplicate');
  const exact = new Set(ARM64_A64_MEMORY_EXACT_MNEMONICS);
  const partial = new Set(ARM64_A64_MEMORY_PARTIAL_MNEMONICS);
  if (exact.size !== ARM64_A64_MEMORY_EXACT_MNEMONICS.length) throw new Error('arm64-memory-denominator-exact-mnemonic-duplicate');
  for (const mnemonic of partial) if (exact.has(mnemonic)) throw new Error(`arm64-memory-denominator-status-overlap:${mnemonic}`);

  const ids = new Set();
  const observedFamilies = new Set();
  const observedExact = new Set();
  const observedPartial = new Set();
  let encodingCaseCount = 0;
  for (const current of arm64A64MemoryEncodingCases()) {
    if (ids.has(current.id)) throw new Error(`arm64-memory-denominator-case-duplicate:${current.id}`);
    ids.add(current.id);
    if (!familyIds.includes(current.familyId)) throw new Error(`arm64-memory-denominator-case-family-unknown:${current.id}`);
    observedFamilies.add(current.familyId);
    if (current.completeness === 'partial') observedPartial.add(current.mnemonic);
    else observedExact.add(current.mnemonic);
    encodingCaseCount++;
  }
  if (observedFamilies.size !== ARM64_A64_MEMORY_ENCODING_FAMILIES.length) throw new Error('arm64-memory-denominator-family-unobserved');
  for (const mnemonic of exact) if (!observedExact.has(mnemonic)) throw new Error(`arm64-memory-denominator-exact-mnemonic-unobserved:${mnemonic}`);
  for (const mnemonic of partial) if (!observedPartial.has(mnemonic)) throw new Error(`arm64-memory-denominator-partial-mnemonic-unobserved:${mnemonic}`);

  return Object.freeze({
    valid:true,
    schemaVersion:ARM64_A64_MEMORY_DENOMINATOR_SCHEMA,
    denominatorId:ARM64_A64_MEMORY_DENOMINATOR_ID,
    profileId:'arm64:a64',
    encodingFamilyCount:ARM64_A64_MEMORY_ENCODING_FAMILIES.length,
    encodingCaseCount,
    mnemonicCount:exact.size + partial.size,
    exactMnemonicCount:exact.size,
    partialMnemonicCount:partial.size,
    oracleIds:Object.freeze(['arm-a-profile-a64-load-store-encoding-tables','deployed-capstone-5-arm64','llvm-aarch64-integrated-assembler-disassembler']),
  });
}
