import { arm64ePointerAuthenticationMnemonics } from '../../../js/targets/architecture/arm64e/effects.js';

export const ARM64E_PAC_DENOMINATOR_SCHEMA = 'arm64e-pac-denominator/v1';
export const ARM64E_PAC_DENOMINATOR_ID = 'arm64e:a64+pac:encoding-discriminators:v1';

const row = (id, mnemonic, mask, match, fields = []) => Object.freeze({ id, mnemonic, mask:mask >>> 0, match:match >>> 0, fields:Object.freeze(fields) });
const TWO = Object.freeze([
  ['pacia',0xdac10000],['pacib',0xdac10400],['pacda',0xdac10800],['pacdb',0xdac10c00],
  ['autia',0xdac11000],['autib',0xdac11400],['autda',0xdac11800],['autdb',0xdac11c00],
]);
const ZERO = Object.freeze([
  ['paciza',0xdac123e0],['pacizb',0xdac127e0],['pacdza',0xdac12be0],['pacdzb',0xdac12fe0],
  ['autiza',0xdac133e0],['autizb',0xdac137e0],['autdza',0xdac13be0],['autdzb',0xdac13fe0],
]);
const FIXED = Object.freeze([
  ['paciasp',0xd503233f],['pacibsp',0xd503237f],['pacia1716',0xd503211f],['pacib1716',0xd503215f],
  ['autiasp',0xd50323bf],['autibsp',0xd50323ff],['autia1716',0xd503219f],['autib1716',0xd50321df],
  ['xpaclri',0xd50320ff],['retaa',0xd65f0bff],['retab',0xd65f0fff],
  ['eretaa',0xd69f0bff],['eretab',0xd69f0fff],
]);
const BRANCH_TWO = Object.freeze([
  ['braa',0xd71f0800],['brab',0xd71f0c00],['blraa',0xd73f0800],['blrab',0xd73f0c00],
]);
const BRANCH_ZERO = Object.freeze([
  ['braaz',0xd61f081f],['brabz',0xd61f0c1f],['blraaz',0xd63f081f],['blrabz',0xd63f0c1f],
]);

export const ARM64E_PAC_ENCODING_FAMILIES = Object.freeze([
  ...TWO.map(([mnemonic,match]) => row(mnemonic,mnemonic,0xfffffc00,match,[0,5])),
  ...ZERO.map(([mnemonic,match]) => row(mnemonic,mnemonic,0xffffffe0,match,[0])),
  ...FIXED.map(([mnemonic,match]) => row(mnemonic,mnemonic,0xffffffff,match)),
  row('xpaci','xpaci',0xffffffe0,0xdac143e0,[0]),
  row('xpacd','xpacd',0xffffffe0,0xdac147e0,[0]),
  row('pacga','pacga',0xffe0fc00,0x9ac03000,[0,5,16]),
  ...BRANCH_TWO.map(([mnemonic,match]) => row(mnemonic,mnemonic,0xfffffc00,match,[0,5])),
  ...BRANCH_ZERO.map(([mnemonic,match]) => row(mnemonic,mnemonic,0xfffffc1f,match,[5])),
]);

export function classifyArm64ePacEncoding(word) {
  const value = Number(word) >>> 0;
  const matches = ARM64E_PAC_ENCODING_FAMILIES.filter((candidate) => ((value & candidate.mask) >>> 0) === candidate.match);
  if (matches.length > 1) throw new Error(`arm64e-pac-denominator-overlap:0x${value.toString(16)}:${matches.map(({id})=>id).join(',')}`);
  return matches[0] || null;
}

export function* arm64ePacEncodingCases() {
  for (const family of ARM64E_PAC_ENCODING_FAMILIES) {
    if (family.fields.length === 0) { yield Object.freeze({ id:family.id, familyId:family.id, mnemonic:family.mnemonic, word:family.match }); continue; }
    const visit = function* (index, word, suffix) {
      if (index === family.fields.length) {
        yield Object.freeze({ id:`${family.id}:${suffix.join(':')}`, familyId:family.id, mnemonic:family.mnemonic, word:word >>> 0 });
        return;
      }
      const shift = family.fields[index];
      for (let register=0; register<32; register++) yield* visit(index+1,(word | (register << shift)) >>> 0,[...suffix,register]);
    };
    yield* visit(0,family.match,[]);
  }
}

export function validateArm64ePacDenominator() {
  const registry = arm64ePointerAuthenticationMnemonics();
  const rows = ARM64E_PAC_ENCODING_FAMILIES;
  if (new Set(rows.map(({id})=>id)).size !== rows.length) throw new Error('arm64e-pac-denominator-family-duplicate');
  if (JSON.stringify([...new Set(rows.map(({mnemonic})=>mnemonic))].sort()) !== JSON.stringify([...registry].sort())) throw new Error('arm64e-pac-denominator-registry-drift');
  let encodingCaseCount=0;
  const observed = new Set();
  for (const candidate of arm64ePacEncodingCases()) {
    const family = classifyArm64ePacEncoding(candidate.word);
    if (!family || family.id !== candidate.familyId) throw new Error(`arm64e-pac-denominator-case-unowned:${candidate.id}`);
    observed.add(family.id); encodingCaseCount++;
  }
  if (observed.size !== rows.length) throw new Error('arm64e-pac-denominator-family-unobserved');
  return Object.freeze({
    valid:true, schemaVersion:ARM64E_PAC_DENOMINATOR_SCHEMA, denominatorId:ARM64E_PAC_DENOMINATOR_ID,
    profileId:'arm64e:a64+pac', encodingFamilyCount:rows.length, encodingCaseCount,
    mnemonicCount:registry.length, registerDiscriminatorCount:32,
    oracleIds:Object.freeze(['arm-architecture-reference-manual-pauth-encodings','deployed-capstone-5-arm64','llvm-mc-18-aarch64-pauth-disassembler']),
  });
}
