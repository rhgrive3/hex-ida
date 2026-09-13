import assert from 'node:assert/strict';

await import('../js/words.js');
const W = globalThis.Words;

// PRFM encodings assembled by llvm-mc. Rt field is the 5-bit prfop, not a GP dest.
const PRFM_IMM_PLDL1KEEP = 0xf9800100; // prfm pldl1keep, [x8]   prfop=0  rn=8
const PRFM_IMM_PLDL3STRM = 0xf981110d; // prfm pldl3strm, [x8,#..] prfop=13 rn=8
const LDR_X0_X8 = 0xf9400100;          // ldr x0, [x8]           real GP load
const LDRSW_X0_X8 = 0xb9800100;        // ldrsw x0, [x8]         real GP load
const STR_X0_X8 = 0xf9000100;          // str x0, [x8]           real GP store
const SIMD_LDR = 0x3d800100;           // ldr q0, [x8]           vector, no GP dest
const PRFM_LITERAL = 0xd8000020;       // prfm pldl1keep, label  prfop=0
const LDR_LITERAL = 0x58000020;        // ldr x0, label          real GP load

let failures = 0;
const check = (name, cond) => {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`);
  }
};

// 1. pairedOffset: PRFM must not publish prfop as a GP destination.
{
  const pair = W.pairedOffset(PRFM_IMM_PLDL1KEEP);
  check('PRFM imm decodes', pair != null);
  check('PRFM imm must be flagged prefetch', pair?.prefetch === true);
  check('PRFM imm must not kill a GP dest (gpDest false)', pair?.gpDest === false);
  check('PRFM imm rn is x8', pair?.rn === 8);

  for (let prfop = 0; prfop < 32; prfop += 1) {
    const word = (0xf9800000 | ((prfop & 0x1f))) >>> 0; // prfop into Rt field, imm12=0, rn=x8
    const p = W.pairedOffset(word);
    check(`prfop ${prfop}: pairedOffset.gpDest === false`, p?.gpDest === false);
    check(`prfop ${prfop}: pairedOffset.prefetch === true`, p?.prefetch === true);
  }
}

// 2. pairedOffset: real loads still expose a GP destination.
{
  const ldr = W.pairedOffset(LDR_X0_X8);
  check('ldr gpDest true', ldr?.gpDest === true && ldr?.prefetch !== true);
  const ldrsw = W.pairedOffset(LDRSW_X0_X8);
  check('ldrsw gpDest true', ldrsw?.gpDest === true && ldrsw?.prefetch !== true);
  const simd = W.pairedOffset(SIMD_LDR);
  check('simd load gpDest false (existing contract)', simd?.gpDest === false && simd?.prefetch !== true);
}

// 3. memoryAccess: PRFM must carry prefetch metadata so reg is not a load dest.
{
  const mem = W.memoryAccess(PRFM_IMM_PLDL1KEEP);
  check('memoryAccess PRFM flagged prefetch', mem?.prefetch === true);
  const str = W.memoryAccess(STR_X0_X8);
  check('memoryAccess str not prefetch', str?.prefetch !== true);
}

// 4. literalTarget: PRFM literal must be distinguishable from a GP literal load.
{
  check('PRFM literal classified LITERAL', W.classifyWord(PRFM_LITERAL) === W.KIND.LITERAL);
  check('PRFM literal detected (literalTarget.prefetch)', W.isPrefetchLiteral?.(PRFM_LITERAL) === true);
  check('LDR literal is not prefetch', W.isPrefetchLiteral?.(LDR_LITERAL) === false);
  check('PRFM imm is not a literal prefetch', W.isPrefetchLiteral?.(PRFM_IMM_PLDL1KEEP) === false);
}

if (failures > 0) {
  console.error(`issue #3955 PRFM raw-word regression FAILED (${failures} assertion(s))`);
  process.exit(1);
}
console.log('issue #3955 PRFM raw-word regression passed');
