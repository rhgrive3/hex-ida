import assert from "node:assert/strict";
import { createCapstoneX86Session } from "./phase5/helpers/capstone-session.mjs";
import { createX86DecodedInstruction } from "../js/targets/architecture/x86_64/decoded-instruction.js";
import { liftX86MachineEffects } from "../js/targets/architecture/x86_64/effects/index.js";
import { isX87Instruction, X87_FAMILIES } from "../js/targets/architecture/x86_64/effects/extended-state-helpers.js";

const capstone = await createCapstoneX86Session();

try {
  // 1 & 2 & 7: FSQRT (D9 FA) must use FPU flags, NOT RFLAGS, and include x86.x87.environment
  {
    const raw = [0xd9, 0xfa];
    const decoded = createX86DecodedInstruction(capstone.decode(raw, 0x1000n)[0]);
    assert.equal(decoded.mnemonic, "fsqrt");
    const effects = liftX86MachineEffects(decoded, { instructionId: "test:fsqrt" });
    assert.ok(effects, "effects must not be null");
    assert.equal(effects.completeness, "exact-with-intrinsic");

    const summary = effects.operations[0].effectSummary;
    const reads = new Set(summary.registersRead);
    const writes = new Set(summary.registersWritten);

    // Must NOT have any rflags
    for (const r of reads) assert.ok(!r.startsWith("rflags."), "FSQRT read must not contain rflags: " + r);
    for (const w of writes) assert.ok(!w.startsWith("rflags."), "FSQRT write must not contain rflags: " + w);

    // Must have fpsw.c0..c3 writes and x86.x87.environment
    assert.ok(writes.has("fpsw.c0"), "FSQRT must write fpsw.c0");
    assert.ok(writes.has("fpsw.c1"), "FSQRT must write fpsw.c1");
    assert.ok(writes.has("fpsw.c2"), "FSQRT must write fpsw.c2");
    assert.ok(writes.has("fpsw.c3"), "FSQRT must write fpsw.c3");

    assert.ok(reads.has("x86.x87.environment"), "FSQRT must read x86.x87.environment");
    assert.ok(writes.has("x86.x87.environment"), "FSQRT must write x86.x87.environment");
  }

  // 3: FSIN (D9 FE), FSINCOS (D9 FB), FSCALE (D9 FD) are x87 families
  for (const [bytes, mnem] of [
    [[0xd9, 0xfe], "fsin"],
    [[0xd9, 0xfb], "fsincos"],
    [[0xd9, 0xfd], "fscale"],
  ]) {
    const decoded = createX86DecodedInstruction(capstone.decode(bytes, 0x2000n)[0]);
    assert.equal(decoded.mnemonic, mnem);
    assert.ok(isX87Instruction(decoded, mnem), mnem + " must be recognized as x87");
    const effects = liftX86MachineEffects(decoded, { instructionId: "test:" + mnem });
    assert.ok(effects);
    assert.equal(effects.completeness, "exact-with-intrinsic");
    const summary = effects.operations[0].effectSummary;
    assert.ok(summary.registersWritten.includes("x86.x87.environment"), mnem + " must have x86.x87.environment");
    for (const w of summary.registersWritten) assert.ok(!w.startsWith("rflags."), mnem + " writes must not contain rflags");
  }

  // 4: FSTP (DD D8), FXAM (D9 E5), FXCH (D9 C9), FXTRACT (D9 F4)
  for (const [bytes, mnem] of [
    [[0xdd, 0xd8], "fstp"],
    [[0xd9, 0xe5], "fxam"],
    [[0xd9, 0xc9], "fxch"],
    [[0xd9, 0xf4], "fxtract"],
  ]) {
    const decoded = createX86DecodedInstruction(capstone.decode(bytes, 0x3000n)[0]);
    assert.equal(decoded.mnemonic, mnem);
    assert.ok(isX87Instruction(decoded, mnem), mnem + " must be recognized as x87");
    const effects = liftX86MachineEffects(decoded, { instructionId: "test:" + mnem });
    assert.ok(effects);
    assert.equal(effects.completeness, "exact-with-intrinsic");
    const summary = effects.operations[0].effectSummary;
    assert.ok(summary.registersWritten.includes("x86.x87.environment"), mnem + " must have x86.x87.environment");
    for (const w of summary.registersWritten) assert.ok(!w.startsWith("rflags."), mnem + " writes must not contain rflags");
  }

  // 6: Integer / System instructions like ADD and RDRAND must still produce rflags correctly and not fpsw
  {
    // add eax, ebx (01 D8) - flag writes
    const add = createX86DecodedInstruction(capstone.decode([0x01, 0xd8], 0x4000n)[0]);
    assert.ok(!isX87Instruction(add, "add"), "add must not be x87");
    const addEffects = liftX86MachineEffects(add, { instructionId: "test:add" });
    assert.ok(addEffects);
    const flagWrites = addEffects.operations.filter(op => op.kind === "flag-write").map(op => op.flag.flagId);
    assert.ok(flagWrites.some(f => f.startsWith("RFLAGS.")), "add must write RFLAGS");

    // rdrand eax (0F C7 F0) - trusted terminal non-x87 flags
    const rdrand = createX86DecodedInstruction(capstone.decode([0x0f, 0xc7, 0xf0], 0x4100n)[0]);
    assert.ok(!isX87Instruction(rdrand, "rdrand"), "rdrand must not be x87");
    const rdrandEffects = liftX86MachineEffects(rdrand, { instructionId: "test:rdrand" });
    assert.ok(rdrandEffects);
    assert.equal(rdrandEffects.completeness, "exact-with-intrinsic");
    const summary = rdrandEffects.operations[0].effectSummary;
    assert.ok(summary.registersWritten.some(r => r.startsWith("rflags.")), "rdrand must write rflags");
    assert.ok(!summary.registersWritten.some(r => r.startsWith("fpsw.")), "rdrand must not write fpsw");
  }

  console.log("issue #6133 x87 trusted terminal flags tests: PASS");
} finally {
  capstone.close();
}
