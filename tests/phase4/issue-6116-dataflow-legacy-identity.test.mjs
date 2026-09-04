import assert from "node:assert/strict";
import test from "node:test";
import { selfRegisters } from "../../js/dataflow-legacy.js";

function modelWithCallName(name) {
  return {
    calls: [{ row: 1, name }],
    instructions: [
      { row: 1, mnemonic: "bl", reads: ["x0"], writes: ["x0"], ops: [], memory: null },
      { row: 2, mnemonic: "str", reads: ["x0"], writes: [], ops: [], memory: null },
    ],
  };
}

test("Issue #6116: only primitive ARC helper names preserve self provenance", () => {
  assert.equal(selfRegisters(modelWithCallName("objc_retain")).isSelf("x0", 2), true);

  for (const name of [
    ["objc_retain"],
    { toString: () => "objc_retain" },
    123,
    true,
  ]) {
    assert.equal(
      selfRegisters(modelWithCallName(name)).isSelf("x0", 2),
      false,
      `structured call name must not be coerced: ${String(name)}`,
    );
  }

  assert.equal(selfRegisters(modelWithCallName("objc_release")).isSelf("x0", 2), false);
});
