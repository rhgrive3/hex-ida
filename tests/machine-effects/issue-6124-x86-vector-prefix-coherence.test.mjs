import assert from 'node:assert/strict';

import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { vectorPrefixOffset } from '../../js/targets/architecture/x86_64/effects/extended-state-helpers.js';

function xmm(name, access) {
  return { type:'register', access, widthBits:128, register:name };
}

function decoded({
  id,
  family,
  rawBytes,
  vector = null,
  legacy = [],
  operands,
  trusted = false,
}) {
  return {
    address:0x1000n,
    length:rawBytes.length,
    rawBytes:Uint8Array.from(rawBytes),
    mode:'long-64',
    instructionId:`issue-6124:${id}`,
    instructionCode:1,
    instructionFamily:family,
    opcodeName:family,
    mnemonic:family,
    detailStatus:'complete',
    detailAvailable:true,
    detail:{
      ...(trusted ? { abiContractVersion:'capstone-5-wasm32-x86-detail/v1' } : {}),
      operandCount:operands.length,
      prefixes:{
        legacy:Uint8Array.from(legacy),
        rex:null,
        vector:vector == null ? null : {
          kind:vector.kind,
          bytes:Uint8Array.from(vector.bytes),
          ...(vector.offset == null ? {} : { offset:vector.offset }),
        },
      },
      operands,
      implicitReads:[],
      implicitWrites:[],
    },
  };
}

function assertRawMismatch(effect, label) {
  assert.ok(effect, `${label}: expected an effect bundle`);
  assert.equal(effect.completeness, 'partial', `${label}: contradictory encoding must fail closed`);
  assert.equal(effect.unknownEffects?.reason, 'x86-vector-prefix-raw-mismatch', `${label}: mismatch reason`);
  assert.equal(effect.metadata?.encodingValidated, false, `${label}: trusted decoder must not re-terminalize mismatch`);
}

const vex2Movups = { kind:'vex2', bytes:[0xc5,0xf8] };
const moveOperands = [xmm('xmm0','write'), xmm('xmm1','read')];

// Minimal counterexample from #6124: raw bytes are legacy MOVUPS, while the
// structured record claims VEX VMOVUPS. The VEX path would zero upper YMM
// state, so accepting the structured prefix as exact changes physical state.
assertRawMismatch(liftX86MachineEffects(decoded({
  id:'forged-vmovups',
  family:'vmovups',
  rawBytes:[0x0f,0x10,0xc1],
  vector:vex2Movups,
  operands:moveOperands,
})), 'legacy raw + forged VEX metadata');

// A reported vector offset is not independent encoding authority. Matching
// VEX-like bytes inside an instruction body must not override the canonical
// cursor reached only through legal legacy/REX prefixes.
const forgedBodyOffset = decoded({
  id:'forged-vex-body-offset',
  family:'vmovups',
  rawBytes:[0x0f,0x10,0x85,0xc5,0xf8,0x00,0x00],
  vector:{ ...vex2Movups, offset:3 },
  operands:moveOperands,
});
assert.equal(
  vectorPrefixOffset(forgedBodyOffset, Uint8Array.from(vex2Movups.bytes)),
  null,
  'reported vector offset inside instruction body must not override canonical prefix cursor',
);
assertRawMismatch(liftX86MachineEffects(forgedBodyOffset), 'forged vector offset inside instruction body');

// A trusted decoder provenance token must not terminalize malformed structured
// prefix metadata. The family validator owns this shape and must remain partial.
const trustedMalformed = liftX86MachineEffects(decoded({
  id:'trusted-malformed-vex',
  family:'vmovups',
  rawBytes:[0x0f,0x10,0xc1],
  vector:{ kind:'vex2', bytes:[0xc5] },
  operands:moveOperands,
  trusted:true,
}));
assert.equal(trustedMalformed?.completeness, 'partial', 'trusted malformed VEX metadata must remain fail closed');
assert.equal(trustedMalformed?.unknownEffects?.reason, 'x86-vector-prefix-metadata-malformed');

const validVex = decoded({
  id:'valid-vmovups',
  family:'vmovups',
  rawBytes:[0xc5,0xf8,0x10,0xc1],
  vector:vex2Movups,
  operands:moveOperands,
});
const validVexEffect = liftX86MachineEffects(validVex);
assert.equal(validVexEffect?.completeness, 'exact', 'matching VEX bytes keep exact VMOVUPS semantics');
assert.equal(validVexEffect?.metadata?.upperLaneBehavior, 'zero-upper-128');

const legacyMove = decoded({
  id:'legacy-movups',
  family:'movups',
  rawBytes:[0x0f,0x10,0xc1],
  operands:moveOperands,
});
const legacyEffect = liftX86MachineEffects(legacyMove);
assert.equal(legacyEffect?.completeness, 'exact', 'legacy MOVUPS remains exact');
assert.equal(legacyEffect?.metadata?.upperLaneBehavior, 'preserve-upper-128', 'legacy/VEX upper-state distinction remains intact');

// Legal legacy prefixes can precede VEX. Coherence must use the canonical
// prefix offset rather than require VEX at rawBytes[0].
for (const [name,prefix] of [['address-size',0x67],['fs-segment',0x64],['gs-segment',0x65]]) {
  const prefixed = decoded({
    id:`prefixed-${name}`,
    family:'vmovups',
    rawBytes:[prefix,0xc5,0xf8,0x10,0xc1],
    vector:vex2Movups,
    legacy:[prefix],
    operands:moveOperands,
  });
  assert.equal(vectorPrefixOffset(prefixed, Uint8Array.from(vex2Movups.bytes)), 1, `${name}: VEX prefix offset`);
  const effect = liftX86MachineEffects(prefixed);
  assert.equal(effect?.completeness, 'exact', `${name}: legal prefixed VEX remains exact`);
  assert.equal(effect?.metadata?.upperLaneBehavior, 'zero-upper-128', `${name}: legal prefixed VEX preserves VEX upper-lane semantics`);
}

assertRawMismatch(liftX86MachineEffects(decoded({
  id:'vex-byte-mismatch',
  family:'vmovups',
  rawBytes:[0xc5,0xf8,0x10,0xc1],
  vector:{ kind:'vex2', bytes:[0xc5,0xf9] },
  operands:moveOperands,
})), 'one-byte VEX metadata mismatch');

assertRawMismatch(liftX86MachineEffects(decoded({
  id:'vex-kind-mismatch',
  family:'vmovups',
  rawBytes:[0xc5,0xf8,0x10,0xc1],
  vector:{ kind:'vex3', bytes:[0xc4,0xe1,0x78] },
  operands:moveOperands,
})), 'VEX2 raw + VEX3 structured kind');

// FP owner used the same structured prefix authority but had no raw-byte gate.
const fpOperands = [xmm('xmm0','write'), xmm('xmm1','read'), xmm('xmm2','read')];
assertRawMismatch(liftX86MachineEffects(decoded({
  id:'forged-vmovss',
  family:'vmovss',
  rawBytes:[0xf3,0x0f,0x10,0xc2],
  vector:{ kind:'vex2', bytes:[0xc5,0xfa] },
  legacy:[0xf3],
  operands:fpOperands,
})), 'FP legacy raw + forged VEX metadata');

const validFp = liftX86MachineEffects(decoded({
  id:'valid-vmovss',
  family:'vmovss',
  rawBytes:[0xc5,0xfa,0x10,0xc2],
  vector:{ kind:'vex2', bytes:[0xc5,0xfa] },
  operands:fpOperands,
}));
assert.equal(validFp?.completeness, 'exact', 'matching VEX bytes keep exact VMOVSS move semantics');
assert.notEqual(validFp?.unknownEffects?.reason, 'x86-vector-prefix-raw-mismatch');

console.log('issue #6124 x86 vector-prefix/raw coherence regressions: PASS');
