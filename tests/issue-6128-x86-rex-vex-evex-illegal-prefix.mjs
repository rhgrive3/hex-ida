import assert from "node:assert/strict";
import { vectorPrefixOffset, evexInfo, vexInfo } from "../js/targets/architecture/x86_64/effects/extended-state-helpers.js";
import { liftX86MachineEffects } from "../js/targets/architecture/x86_64/effects/index.js";
import { createCapstoneX86Session } from "./phase5/helpers/capstone-session.mjs";
import { createX86DecodedInstruction } from "../js/targets/architecture/x86_64/decoded-instruction.js";

// Helper to create synthetic decoded instruction for testing
function createInstruction({ raw, rex = null, vectorKind, vectorBytes, vectorOffset = null, operands = [] }) {
  const rawBytes = Uint8Array.from(raw);
  return {
    address: 0x1000n,
    length: rawBytes.length,
    rawBytes,
    mode: "long-64",
    instructionCode: 12345,
    instructionFamily: "vaddps",
    instructionId: "test:rex-vector",
    detailAvailable: true,
    detailStatus: "complete",
    decoderSemanticVersion: "capstone-5-x86-structured-v2",
    mnemonic: "vaddps",
    opStr: "",
    detail: {
      abiContractVersion: "capstone-5-wasm32-x86-detail/v1",
      operandCount: operands.length,
      operands,
      prefixes: {
        legacy: [],
        rex,
        vector: vectorKind ? {
          kind: vectorKind,
          bytes: vectorBytes,
          offset: vectorOffset ?? (rex ? 1 : 0),
          fieldsVerified: false,
        } : null,
      },
      implicitReads: [],
      implicitWrites: [],
      conditionCode: null,
    },
  };
}

const standardOperands = [
  { type: "register", register: { id: "xmm0" }, access: "write" },
  { type: "register", register: { id: "xmm1" }, access: "read" },
  { type: "register", register: { id: "xmm2" }, access: "read" }
];

// 1: 48 C5 ... (REX.W + VEX2) must reject and return null for vectorPrefixOffset
{
  const vex2Bytes = [0xc5, 0xf8];
  const insn = createInstruction({
    raw: [0x48, ...vex2Bytes, 0x58, 0xc1],
    rex: 0x48,
    vectorKind: "vex2",
    vectorBytes: vex2Bytes,
    operands: standardOperands,
  });
  assert.equal(vectorPrefixOffset(insn, vex2Bytes), null, "REX+VEX2 must return null offset");
  assert.equal(vexInfo(insn), null, "vexInfo must reject REX+VEX2");
  const effects = liftX86MachineEffects(insn, { instructionId: "test:rex-vex2" });
  assert.equal(effects.completeness, "partial", "REX+VEX2 must not reach exact semantics");
  assert.equal(effects.unknownEffects.reason, "x86-vector-prefix-raw-mismatch");
}

// 2: 4F C4 ... (REX.WRXB + VEX3) must reject
{
  const vex3Bytes = [0xc4, 0xe1, 0x78];
  const insn = createInstruction({
    raw: [0x4f, ...vex3Bytes, 0x58, 0xc1],
    rex: 0x4f,
    vectorKind: "vex3",
    vectorBytes: vex3Bytes,
    operands: standardOperands,
  });
  assert.equal(vectorPrefixOffset(insn, vex3Bytes), null, "REX+VEX3 must return null offset");
  assert.equal(vexInfo(insn), null, "vexInfo must reject REX+VEX3");
  const effects = liftX86MachineEffects(insn, { instructionId: "test:rex-vex3" });
  assert.equal(effects.completeness, "partial", "REX+VEX3 must not reach exact semantics");
  assert.equal(effects.unknownEffects.reason, "x86-vector-prefix-raw-mismatch");
}

// 3: 48 62 ... (REX.W + EVEX) must reject and fail closed
{
  const evexBytes = [0x62, 0xf1, 0x7c, 0x08];
  const insn = createInstruction({
    raw: [0x48, ...evexBytes, 0x58, 0xc1],
    rex: 0x48,
    vectorKind: "evex",
    vectorBytes: evexBytes,
    operands: standardOperands,
  });
  assert.equal(vectorPrefixOffset(insn, evexBytes), null, "REX+EVEX must return null offset");
  assert.equal(evexInfo(insn), null, "evexInfo must reject REX+EVEX");
  const effects = liftX86MachineEffects(insn, { instructionId: "test:rex-evex" });
  assert.equal(effects.completeness, "partial", "REX+EVEX must not reach exact semantics");
  assert.equal(effects.unknownEffects.reason, "x86-vector-prefix-raw-mismatch");
}

// 4: Valid VEX2/VEX3/EVEX without REX must succeed
{
  const vex2Bytes = [0xc5, 0xf8];
  const insn = createInstruction({
    raw: [...vex2Bytes, 0x58, 0xc1],
    rex: null,
    vectorKind: "vex2",
    vectorBytes: vex2Bytes,
    vectorOffset: 0,
    operands: standardOperands,
  });
  assert.equal(vectorPrefixOffset(insn, vex2Bytes), 0, "Valid VEX2 offset must be 0");

  const evexBytes = [0x62, 0xf1, 0x7c, 0x08];
  const insnEvex = createInstruction({
    raw: [...evexBytes, 0x58, 0xc1],
    rex: null,
    vectorKind: "evex",
    vectorBytes: evexBytes,
    vectorOffset: 0,
    operands: standardOperands,
  });
  assert.equal(vectorPrefixOffset(insnEvex, evexBytes), 0, "Valid EVEX offset must be 0");
}

// 5: Allowed legacy prefix (e.g. 0x67 address-size or 0x64 FS segment override) before VEX/EVEX must preserve offset
{
  const vex2Bytes = [0xc5, 0xf8];
  const insnAddrSize = createInstruction({
    raw: [0x67, ...vex2Bytes, 0x58, 0xc1],
    rex: null,
    vectorKind: "vex2",
    vectorBytes: vex2Bytes,
    vectorOffset: 1,
    operands: standardOperands,
  });
  assert.equal(vectorPrefixOffset(insnAddrSize, vex2Bytes), 1, "0x67 + VEX2 offset must be 1");

  const evexBytes = [0x62, 0xf1, 0x7c, 0x08];
  const insnFs = createInstruction({
    raw: [0x64, ...evexBytes, 0x58, 0xc1],
    rex: null,
    vectorKind: "evex",
    vectorBytes: evexBytes,
    vectorOffset: 1,
    operands: standardOperands,
  });
  assert.equal(vectorPrefixOffset(insnFs, evexBytes), 1, "0x64 + EVEX offset must be 1");
}

// 6: Structured prefix bytes mismatch with raw bytes must fail closed
{
  const vex2Bytes = [0xc5, 0xf8];
  const insnMismatch = createInstruction({
    raw: [0xc5, 0xf9, 0x58, 0xc1],
    rex: null,
    vectorKind: "vex2",
    vectorBytes: vex2Bytes,
    vectorOffset: 0,
    operands: standardOperands,
  });
  assert.equal(vectorPrefixOffset(insnMismatch, vex2Bytes), null, "Mismatched bytes must return null");
}

// 7: Capstone session smoke test on normal instruction
const capstone = await createCapstoneX86Session();
try {
  // Normal vaddps xmm0, xmm1, xmm2 (C5 F8 58 C2)
  const decodedNormal = capstone.decode([0xc5, 0xf8, 0x58, 0xc2], 0x2000n)[0];
  assert.equal(decodedNormal.mnemonic, "vaddps");
  assert.equal(decodedNormal.detail.prefixes.vector.kind, "vex2");
  assert.equal(decodedNormal.detail.prefixes.vector.offset, 0);
} finally {
  capstone.close();
}

console.log("issue #6128 REX+VEX/EVEX illegal prefix tests: PASS");
