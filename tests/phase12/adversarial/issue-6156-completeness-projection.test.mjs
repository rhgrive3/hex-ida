import assert from "node:assert/strict";
import test from "node:test";
import { completenessOf } from "../../../js/ai/tools/projections/index.js";

test("Issue #6156: malformed completeness metadata cannot become complete", () => {
  assert.deepEqual(
    completenessOf({ completeness: { complete: true, returned: 1, total: 1, coverage: 1 } }),
    { complete: true, returned: 1, total: 1, coverage: 1, reason: null },
  );

  assert.deepEqual(
    completenessOf({
      completeness: { complete: "false", returned: ["1"], total: ["1"], coverage: ["1"] },
    }),
    { complete: false, returned: 0, total: null, coverage: null, reason: "malformed-completeness" },
  );

  for (const value of ["1", [1], true, { value: 1 }, Infinity]) {
    assert.equal(
      completenessOf({ completeness: { coverage: value } }).coverage,
      null,
      `coverage must remain unknown for structured value ${String(value)}`,
    );
  }

  assert.equal(completenessOf({ results: [], complete: "false" }).complete, false);
  assert.equal(completenessOf({ results: [], truncated: "false" }).complete, false);
});
