// Exact-head proof retrigger after canonical userscript autofix; assertions unchanged.
import assert from "node:assert/strict";

import { createCapstoneX86Session } from "../phase5/helpers/capstone-session.mjs";
import { createX86DecodedInstruction } from "../../js/targets/architecture/x86_64/decoded-instruction.js";
import { dispatchX86MachineEffects } from "../../js/targets/architecture/x86_64/effects/index.js";
import { X86_LONG64_DECODER_WITNESSES } from "../../tools/validation/machine-effects/fixtures/x86-long64-decoder-witnesses.mjs";
import { bytesFromX86Long64WitnessHex } from "../../tools/validation/machine-effects/x86-long64-decoder-denominator.mjs";
import {
  X86_LONG64_CLOSURE_MATRIX_ID,
  X86_LONG64_CLOSURE_MATRIX_SCHEMA,
  evaluateX86Long64ClosureMatrix,
  validateX86Long64ClosureMatrix,
} from "../../tools/validation/machine-effects/x86-long64-closure-matrix.mjs";

const session = await createCapstoneX86Session();
try {
  const decodedRows = [];
  for (const [id, name, hex] of X86_LONG64_DECODER_WITNESSES) {
    const bytes = bytesFromX86Long64WitnessHex(hex);
    const decoded = session.decode(bytes, 0x100000n + BigInt(id) * 0x20n);
    assert.equal(decoded.length, 1, "instruction must decode once: " + name);
    const instruction = createX86DecodedInstruction({ ...decoded[0], instructionId: "closure-witness:" + id });
    if (id === 116 || id === 377 || id === 378) {
      console.log("X86_CLOSURE_RESIDUAL_WITNESS", JSON.stringify({ id, name, hex, instruction }));
    }
    decodedRows.push(Object.freeze({ id, name, hex, instruction }));
  }

  const matrix = evaluateX86Long64ClosureMatrix(decodedRows, dispatchX86MachineEffects);
  assert.equal(validateX86Long64ClosureMatrix(matrix), true);
  assert.equal(matrix.schemaVersion, X86_LONG64_CLOSURE_MATRIX_SCHEMA);
  assert.equal(matrix.matrixId, X86_LONG64_CLOSURE_MATRIX_ID);
  assert.equal(matrix.totalWitnessCount, 1487);
  assert.equal(matrix.unownedCount, 0, "No witness may be unowned");
  assert.equal(matrix.partialCount, 0, `No valid witness may remain partial: ${JSON.stringify(matrix.blockingGaps)}`);
  assert.equal(matrix.blockingGapCount, 0, `No semantic closure gap may remain: ${JSON.stringify(matrix.blockingGaps)}`);
  assert.equal(matrix.closed, true, `Long-64 witness matrix must be terminal: ${JSON.stringify(matrix.blockingGaps)}`);
  assert.equal(matrix.rows.length, 1487);

  for (const row of matrix.rows) {
    assert.ok(row.id >= 1 && row.id <= 1523);
    assert.ok(typeof row.name === "string" && row.name.length > 0);
    assert.ok(typeof row.hex === "string" && row.hex.length > 0);
    assert.ok(["control", "memory", "lea", "integer", "string", "atomic", "fp", "simd", "system"].includes(row.ownerId));
    assert.ok(["exact", "exact-with-intrinsic", "partial"].includes(row.completeness));
    assert.ok(Array.isArray(row.registersRead));
    assert.ok(Array.isArray(row.registersWritten));
    assert.ok(Array.isArray(row.faultKinds));
    assert.ok(typeof row.requiredFeature === "string");
  }

  console.log(JSON.stringify({
    matrixId: matrix.matrixId,
    totalWitnessCount: matrix.totalWitnessCount,
    exactTotal: matrix.exactTotal,
    partialCount: matrix.partialCount,
    unownedCount: matrix.unownedCount,
    blockingGapCount: matrix.blockingGapCount,
    closed: matrix.closed,
    byCompleteness: matrix.byCompleteness,
    byOwner: matrix.byOwner,
    completenessByOwner: matrix.completenessByOwner,
  }));
} finally {
  session.close();
}

console.log("x86 long-64 1487 semantic closure matrix: PASS");