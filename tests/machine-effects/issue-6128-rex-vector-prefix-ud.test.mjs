import assert from 'node:assert/strict';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { vectorPrefixOffset, evexInfo } from '../../js/targets/architecture/x86_64/effects/extended-state-helpers.js';

function xmm(name, access) {
  return { type: 'register', access, widthBits: 128, register: name };
}

function decoded({ id, family, rawBytes, vector = null, rex = null, legacy = [], operands, trusted = false }) {
  return {
    address: 0x1000n,
    length: rawBytes.length,
    rawBytes: Uint8Array.from(rawBytes),
    mode: 'long-64',
    instructionId: `issue-6128:${id}`,
    instructionCode: 1,
    instructionFamily: family,
    opcodeName: family,
    mnemonic: family,
    detailStatus: 'complete',
    detailAvailable: true,
    detail: {
      ...(trusted ? { abiContractVersion: 'capstone-5-wasm32-x86-detail/v1' } : {}),
      operandCount: operands.length,
      prefixes: {
        legacy: Uint8Array.from(legacy),
        rex,
        vector: vector == null ? null : { kind: vector.kind, bytes: Uint8Array.from(vector.bytes), ...(vector.offset == null ? {} : { offset: vector.offset }) },
      },
      operands,
      implicitReads: [],
      implicitWrites: [],
    },
  };
}

const evexBytes = [0x62, 0x01, 0x04, 0x00];
const moveOperands = [xmm('xmm0', 'write'), xmm('xmm1', 'read')];

// #6128 minimal counterexample: REX.W + EVEX-like bytes. REX is #UD in front
// of an EVEX escape prefix, so the locator must not consume it to reach a
// byte match.
const rexPlusEvex = decoded({
  id: 'rex-plus-evex',
  family: 'vptestmd',
  rawBytes: [0x48, ...evexBytes],
  vector: { kind: 'evex', bytes: evexBytes },
  rex: 0x48,
  operands: moveOperands,
});
assert.equal(vectorPrefixOffset(rexPlusEvex, Uint8Array.from(evexBytes)), null, 'REX must not be consumed to reach an EVEX prefix');
assert.equal(evexInfo(rexPlusEvex), null, 'REX+EVEX must never produce coherent EVEX info');

// Same for VEX2/VEX3 leads.
for (const [lead, width] of [[0xc5, 2], [0xc4, 3]]) {
  const bytes = [lead, 0xf8, 0x10, 0xc1].slice(0, width);
  const rexPlusVex = decoded({
    id: `rex-plus-${lead === 0xc5 ? 'vex2' : 'vex3'}`,
    family: 'vmovups',
    rawBytes: [0x48, ...bytes],
    vector: { kind: lead === 0xc5 ? 'vex2' : 'vex3', bytes },
    rex: 0x48,
    operands: moveOperands,
  });
  assert.equal(vectorPrefixOffset(rexPlusVex, Uint8Array.from(bytes)), null, `REX must not be consumed to reach a ${lead === 0xc5 ? 'VEX2' : 'VEX3'} prefix`);
}

// A trusted record riding the invalid encoding stays fail-closed (never
// exact-with-intrinsic), and a VEX lead after REX is raw-mismatch partial.
{
  const effect = liftX86MachineEffects(rexPlusEvex);
  assert.ok(effect == null || effect.completeness === 'partial', 'REX+EVEX must fail closed (null or partial), never exact');
}
{
  const rexPlusVex2 = decoded({
    id: 'rex-plus-vex2-lift',
    family: 'vmovups',
    rawBytes: [0x48, 0xc5, 0xf8, 0x10, 0xc1],
    vector: { kind: 'vex2', bytes: [0xc5, 0xf8] },
    rex: 0x48,
    operands: moveOperands,
    trusted: true,
  });
  const effect = liftX86MachineEffects(rexPlusVex2);
  assert.ok(effect, 'VEX bundle required');
  assert.equal(effect.completeness, 'partial', 'REX+VEX2 must fail closed');
  assert.equal(effect.unknownEffects?.reason, 'x86-vector-prefix-raw-mismatch');
}

// Legal encodings keep their exact semantics: REX with a LEGACY (non-extended)
// opcode, VEX without REX, and legacy prefixes + VEX.
{
  const rexLegacy = decoded({
    id: 'rex-legacy-mov',
    family: 'movups',
    rawBytes: [0x66, 0x0f, 0x10, 0xc1],
    operands: moveOperands,
  });
  const effect = liftX86MachineEffects(rexLegacy);
  assert.ok(effect, 'legacy bundle required');
}
{
  const vex = decoded({
    id: 'vex-no-rex',
    family: 'vmovups',
    rawBytes: [0xc5, 0xf8, 0x10, 0xc1],
    vector: { kind: 'vex2', bytes: [0xc5, 0xf8] },
    operands: moveOperands,
  });
  const effect = liftX86MachineEffects(vex);
  assert.equal(effect?.completeness, 'exact', 'VEX without REX keeps exact semantics');
}
for (const [name, prefix] of [['address-size', 0x67], ['fs-segment', 0x64]]) {
  const prefixed = decoded({
    id: `legal-${name}-prefix-vex`,
    family: 'vmovups',
    rawBytes: [prefix, 0xc5, 0xf8, 0x10, 0xc1],
    vector: { kind: 'vex2', bytes: [0xc5, 0xf8] },
    legacy: [prefix],
    operands: moveOperands,
  });
  const effect = liftX86MachineEffects(prefixed);
  assert.equal(effect?.completeness, 'exact', `${name} prefix + VEX stays exact`);
}

console.log('x86 REX+VEX/EVEX extended-encoding #UD authority (#6128): PASS');
