import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeAnalysisPlatform } from "../../../js/runtime/index.js";
import { compileExperiment } from "../../../js/dynamic/experiments.js";
import { DebugAdapterError } from "../../../js/debug/adapter.js";

function program(instructions) {
  const entries = instructions.map(([address, op, args]) => ({ address, op, args, bytes: [] }));
  return { kind: "instructions", entries, byteLength: entries.length * 4 };
}

class FakeAdapter {
  async getThreads() { return [{ id: 1 }]; }
  async getModules() { return [{ id: "m" }]; }
}

test("issue #6139 - hypothesis bound to another binary is rejected with binary-version-mismatch", async () => {
  const io = program([[0x1000, "mov", "x0, #1"], [0x1004, "ret", ""]]);
  const platform = new RuntimeAnalysisPlatform({ localIO: io, symbolic: false });
  await platform.startSession({ binaryHash: "bin-B" });

  const hypothesis = {
    id: "h-foreign",
    binaryHash: "bin-A",
    functionAddress: 0x1000n,
    fieldOffset: 0n,
    fieldSize: 8,
    initial: 100,
    argumentIndex: 1,
    operation: "set",
  };

  await assert.rejects(
    platform.verifyHypothesis(hypothesis),
    (error) => error instanceof DebugAdapterError
      && error.code === "binary-version-mismatch"
      && error.details?.hypothesisHash === "bin-A"
      && error.details?.sessionHash === "bin-B",
  );
});

test("issue #6139 - hypothesis matching the session hash runs as before", async () => {
  const io = program([[0x1000, "mov", "x0, #1"], [0x1004, "ret", ""]]);
  const platform = new RuntimeAnalysisPlatform({ localIO: io, symbolic: false });
  await platform.startSession({ binaryHash: "bin-A" });

  const hypothesis = {
    id: "h-same",
    binaryHash: "bin-A",
    functionAddress: 0x1000n,
    fieldOffset: 0n,
    fieldSize: 8,
    initial: 100,
    argumentIndex: 1,
    operation: "set",
  };

  const result = await platform.verifyHypothesis(hypothesis);
  assert.ok(result.cases.length >= 1);
  assert.ok(result.evidence.length > 0, "the assertion must observe actual evidence");
  assert.equal(result.evidence.every((item) => item.binaryHash === "bin-A"), true);
});

test("issue #6139 - hypothesis without a hash inherits the session hash", async () => {
  const io = program([[0x1000, "mov", "x0, #1"], [0x1004, "ret", ""]]);
  const platform = new RuntimeAnalysisPlatform({ localIO: io, symbolic: false });
  await platform.startSession({ binaryHash: "bin-B" });

  const hypothesis = {
    id: "h-unbound",
    functionAddress: 0x1000n,
    fieldOffset: 0n,
    fieldSize: 8,
    initial: 100,
    argumentIndex: 1,
    operation: "set",
  };

  const result = await platform.verifyHypothesis(hypothesis);
  assert.ok(result.cases.length >= 1);
  assert.ok(result.evidence.length > 0, "the assertion must observe actual evidence");
  assert.equal(result.evidence.every((item) => item.binaryHash === "bin-B"), true);
});

test("issue #6139 - compileExperiment keeps an explicit hypothesis binding over a different session hash", () => {
  const experiment = compileExperiment(
    { id: "h1", binaryHash: "bin-A", functionAddress: 0x1000n },
    { binaryHash: "bin-B" },
  );
  assert.equal(experiment.binaryHash, "bin-A");
});

// CodeRabbit's unbound-session counterexample must exercise the actual factory,
// whose existing binaryHash || experiment.binaryHash fallback preserves binding.
test("issue #6139 - unbound session preserves the explicit hypothesis hash in actual evidence", async () => {
  const platform = new RuntimeAnalysisPlatform({
    localIO: program([[0x1000, "mov", "x0, #1"], [0x1004, "ret", ""]]),
    symbolic: false,
  });
  const session = await platform.startSession();
  assert.equal(session.binaryHash, null);
  const result = await platform.verifyHypothesis({
    id: "h-bound-unbound-session", binaryHash: "bin-A", functionAddress: 0x1000n,
    fieldOffset: 0n, fieldSize: 8, initial: 100, argumentIndex: 1, operation: "set",
  });
  assert.ok(result.evidence.length > 0, "the actual verifier must publish evidence");
  for (const item of result.evidence) {
    assert.equal(item.binaryHash, "bin-A");
    assert.equal(item.sessionId, session.id);
    assert.ok(platform.evidence.includes(item));
  }
  assert.equal(session.binaryHash, null, "verification must not silently rebind the session");
});
