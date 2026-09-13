import assert from "node:assert/strict";
import test from "node:test";

import { DebugAdapterError } from "../../../js/debug/adapter.js";
import { compileExperiment } from "../../../js/dynamic/experiments.js";

const base = {
  functionAddress: 0x1000n,
  fieldOffset: 0n,
  fieldSize: 8,
  initial: 100n,
  argumentIndex: 1,
  operation: "set",
};

function rejectsId(hypothesis, label) {
  assert.throws(
    () => compileExperiment({ ...base, ...hypothesis }),
    (error) => error instanceof DebugAdapterError && error.code === "invalid-hypothesis",
    label,
  );
}

test("issue #4317 - an explicit string hypothesis id is the canonical experiment and case identity", () => {
  const experiment = compileExperiment({ ...base, id: "h1" });
  assert.equal(experiment.id, "h1");
  assert.ok(experiment.cases.length > 0);
  for (const item of experiment.cases) assert.ok(item.id.startsWith(`${experiment.id}:`), item.id);
});

test("issue #4317 - a nullish hypothesis id keeps the deterministic fallback", () => {
  for (const id of [undefined, null]) {
    const experiment = compileExperiment({ ...base, id });
    assert.equal(experiment.id, "experiment:1000");
    assert.ok(experiment.cases.length > 0);
    for (const item of experiment.cases) assert.ok(item.id.startsWith("hypothesis:"), item.id);
  }
});

test("issue #4317 - a structured hypothesis id never aliases a canonical string id", () => {
  rejectsId({ id: ["h1"] }, "array id must not coerce to its single element");
  rejectsId({ id: { toString: () => "h1" } }, "object id must not coerce through toString");
});

test("issue #4317 - number, boolean and explicit falsy ids are rejected, not coerced or defaulted", () => {
  for (const id of [5, 0, true, false, "", "   "]) rejectsId({ id }, `id ${JSON.stringify(id)}`);
});
