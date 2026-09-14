import assert from 'node:assert/strict';

import { createCapstoneX86Session } from "../../phase5/helpers/capstone-session.mjs";
import { createX86DecodedInstruction } from "../../../js/targets/architecture/x86_64/decoded-instruction.js";
import { dispatchX86MachineEffects } from "../../../js/targets/architecture/x86_64/effects/index.js";
import { X86_LONG64_EVEX_DENOMINATOR_FAMILIES } from "../../../js/targets/architecture/x86_64/effects/evex-denominator-families.js";
import { X86_LONG64_DECODER_WITNESSES } from "../../../tools/validation/machine-effects/fixtures/x86-long64-decoder-witnesses.mjs";
import {
  bytesFromX86Long64WitnessHex,
  X86_LONG64_CANONICAL_EFFECT_OWNERS,
} from "../../../tools/validation/machine-effects/x86-long64-decoder-denominator.mjs";
import { evaluateX86Long64ClosureMatrix } from "../../../tools/validation/machine-effects/x86-long64-closure-matrix.mjs";

// #8874: after the receiver-provenance hardening, 233 frozen EVEX denominator
// witnesses fell through the generic EVEX owner to `ownerId:'fallback' /
// result:null`. The owner-retention allowlist was a hand-written partial view
// of the denominator. This regression proves the unified denominator inventory
// keeps every valid member owned with an explicit fail-closed partial, while
// (a) non-denominator/synthetic spellings stay unowned, (b) no row gains
// terminal exactness without the receiver brand, and (c) the frozen inventory
// cannot drift from or shrink below the denominator.
const PROVENANCE_PARTIAL = "x86-evex-trusted-decoder-provenance-required";
const OWNER_SET = new Set(X86_LONG64_CANONICAL_EFFECT_OWNERS);

const session = await createCapstoneX86Session();
let matrix;
let evexFamiliesFromDenominator;
let valignqRow;
try {
  const decodedRows = [];
  evexFamiliesFromDenominator = new Set();
  for (const [id, name, hex] of X86_LONG64_DECODER_WITNESSES) {
    const bytes = bytesFromX86Long64WitnessHex(hex);
    const decoded = session.decode(bytes, 0x100000n + BigInt(id) * 0x20n);
    assert.equal(decoded.length, 1, "instruction must decode once: " + name);
    const instruction = createX86DecodedInstruction({ ...decoded[0], instructionId: "issue-8874:" + id });
    decodedRows.push(Object.freeze({ id, name, hex, instruction }));
    if (String(instruction.detail?.prefixes?.vector?.kind || "").toLowerCase() === "evex") {
      evexFamiliesFromDenominator.add(String(instruction.instructionFamily || "").toLowerCase());
    }
    if (name === "valignq") valignqRow = instruction;
  }
  matrix = evaluateX86Long64ClosureMatrix(decodedRows, dispatchX86MachineEffects);
} finally {
  session.close();
}

// (1) Acceptance: the closure denominator has zero unowned witnesses.
assert.equal(matrix.unownedCount, 0, "no denominator witness may be unowned");
assert.equal(matrix.totalWitnessCount, 1487, "the 1487 denominator must not shrink");
for (const gap of matrix.blockingGaps) {
  assert.equal(gap.completeness, "partial", `gap must stay an explicit partial, got ${JSON.stringify(gap)}`);
  assert.notEqual(gap.reason, "unowned-or-invalid-owner");
}

// (2) Representative formerly-fallback families keep a canonical owner with
// the stable provenance-required partial reason (no fake exactness).
for (const family of ["valignq", "vcompresspd", "vexpandps", "vcvtudq2ps", "vbroadcastf32x2", "vcvtqq2pd"]) {
  const row = matrix.rows.find((candidate) => candidate.name === family);
  assert.ok(row, `denominator must still contain ${family}`);
  assert.ok(OWNER_SET.has(row.ownerId), `${family} must have a canonical owner, got ${row.ownerId}`);
  assert.equal(row.completeness, "partial", `${family} without receiver brand must stay partial`);
  assert.equal(row.partialReason, PROVENANCE_PARTIAL, `${family} must carry the stable provenance reason`);
}

// (3) No promotion without the receiver brand: unbranded canonical rows keep
// the same exact/exact-with-intrinsic totals as before the retention repair.
assert.equal(
  matrix.exactCount + matrix.exactWithIntrinsicCount,
  285,
  "owner retention must not mint exactness for unbranded rows",
);
const provenancePartials = matrix.rows.filter((row) => row.partialReason === PROVENANCE_PARTIAL);
assert.ok(
  provenancePartials.every((row) => row.completeness === "partial" && OWNER_SET.has(row.ownerId)),
  "every provenance-required witness is an owned explicit partial",
);

// (4) True synthetic/non-denominator EVEX spellings stay fail-closed unowned.
const synthetic = structuredClone(valignqRow);
synthetic.instructionFamily = "vnotadenominatorfamily";
synthetic.opcodeName = "vnotadenominatorfamily";
synthetic.mnemonic = "vnotadenominatorfamily";
const syntheticOutcome = dispatchX86MachineEffects(synthetic, { closureMatrixTerminal: true, instructionId: "issue-8874:synthetic" });
assert.equal(syntheticOutcome.ownerId, "fallback", "a non-denominator spelling must not acquire an owner");
assert.equal(syntheticOutcome.result, null);

// (5) Single authority: the frozen js inventory is exactly the denominator's
// EVEX family set (machine-derived; drift or shrink fails the lane).
assert.deepEqual(
  [...X86_LONG64_EVEX_DENOMINATOR_FAMILIES].sort(),
  [...evexFamiliesFromDenominator].sort(),
  "the frozen EVEX inventory must equal the denominator family set",
);
assert.equal(X86_LONG64_EVEX_DENOMINATOR_FAMILIES.length, evexFamiliesFromDenominator.size, "no duplicate inventory entries");

console.log("issue-8874 x86 EVEX denominator owner retention: PASS");
