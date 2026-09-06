import assert from "node:assert/strict";
import { liftArm64MachineEffects } from "../../js/targets/architecture/arm64/effects/index.js";

// 1: ADR k:"other", text:"0x1004" + pcRelTarget:0x1004n -> exact maintained
{
  const insn = {
    mnemonic: "adr",
    address: 0x1000n,
    length: 4,
    pcRelTarget: 0x1004n,
    ops: [
      { k: "reg", cls: "gp", num: 0, bits: 64 },
      { k: "other", text: "0x1004" },
    ],
    origin: { instructionIds: ["adr-match-other"] },
  };
  const effects = liftArm64MachineEffects(insn, { instructionId: "test:adr:match" });
  assert.ok(effects);
  assert.equal(effects.completeness, "exact");
  assert.equal(effects.operations[0].kind, "register-write");
  assert.equal(effects.operations[0].register.registerId, "x0");
  assert.equal(effects.operations[0].value.value, "4100"); // 0x1004 in decimal
}

// 2: ADR k:"other", text:"0x2000" + pcRelTarget:0x1004n -> partial, no register write
{
  const insn = {
    mnemonic: "adr",
    address: 0x1000n,
    length: 4,
    pcRelTarget: 0x1004n,
    ops: [
      { k: "reg", cls: "gp", num: 0, bits: 64 },
      { k: "other", text: "0x2000" },
    ],
    origin: { instructionIds: ["adr-other-target-conflict"] },
  };
  const effects = liftArm64MachineEffects(insn, { instructionId: "test:adr:conflict" });
  assert.ok(effects);
  assert.equal(effects.completeness, "partial");
  assert.equal(effects.unknownEffects.reason, "arm64-adr-target-evidence-mismatch");
  assert.equal(effects.operations.length, 0, "must not produce register write");
}

// 3: ADR canonical k:"imm" mismatch -> existing fail-closed maintained
{
  const insn = {
    mnemonic: "adr",
    address: 0x1000n,
    length: 4,
    pcRelTarget: 0x1004n,
    ops: [
      { k: "reg", cls: "gp", num: 0, bits: 64 },
      { k: "imm", value: 0x2000n },
    ],
    origin: { instructionIds: ["adr-imm-target-conflict"] },
  };
  const effects = liftArm64MachineEffects(insn, { instructionId: "test:adr:imm-conflict" });
  assert.ok(effects);
  assert.equal(effects.completeness, "partial");
  assert.equal(effects.unknownEffects.reason, "arm64-adr-target-evidence-mismatch");
  assert.equal(effects.operations.length, 0);
}

// 4: pcRelTarget absent + numeric other.text -> exact target inferred
{
  const insn = {
    mnemonic: "adr",
    address: 0x1000n,
    length: 4,
    ops: [
      { k: "reg", cls: "gp", num: 0, bits: 64 },
      { k: "other", text: "0x1004" },
    ],
    origin: { instructionIds: ["adr-other-inferred"] },
  };
  const effects = liftArm64MachineEffects(insn, { instructionId: "test:adr:inferred" });
  assert.ok(effects);
  assert.equal(effects.completeness, "exact");
  assert.equal(effects.operations[0].value.value, "4100");
}

// 5: nonnumeric other.text + valid explicit target -> maintain existing behavior
{
  const insn = {
    mnemonic: "adr",
    address: 0x1000n,
    length: 4,
    pcRelTarget: 0x1004n,
    ops: [
      { k: "reg", cls: "gp", num: 0, bits: 64 },
      { k: "other", text: "my_label" },
    ],
    origin: { instructionIds: ["adr-label"] },
  };
  const effects = liftArm64MachineEffects(insn, { instructionId: "test:adr:label" });
  assert.ok(effects);
  assert.equal(effects.completeness, "exact");
  assert.equal(effects.operations[0].value.value, "4100");
}

// 6: ADRP numeric other.text / page target conflict -> fail-closed
{
  const insn = {
    mnemonic: "adrp",
    address: 0x1000n,
    length: 4,
    pcRelTarget: 0x2000n,
    ops: [
      { k: "reg", cls: "gp", num: 0, bits: 64 },
      { k: "other", text: "0x5000" },
    ],
    origin: { instructionIds: ["adrp-other-conflict"] },
  };
  const effects = liftArm64MachineEffects(insn, { instructionId: "test:adrp:conflict" });
  assert.ok(effects);
  assert.equal(effects.completeness, "partial");
  assert.equal(effects.unknownEffects.reason, "arm64-adrp-target-evidence-mismatch");
  assert.equal(effects.operations.length, 0);
}

console.log("issue #6101 ARM64 ADR/ADRP target coherence tests: PASS");
