import assert from "node:assert/strict";
import { liftArm64AtomicEffects } from "../js/targets/architecture/arm64/effects/atomic.js";
import { liftArm64SystemEffects } from "../js/targets/architecture/arm64/effects/system.js";
import { createEntityId, createEvidenceId, createArtifactId } from "../js/core/identity/index.js";
import { createAliasResult } from "../js/analysis/alias/result.js";

// Issue #2319: reject barrier modifiers
{
  const liftedDmb = liftArm64AtomicEffects({
    instructionId: "inst_1",
    mnemonic: "dmb",
    ops: [{ k: "imm", value: 15n, shift: { op: "lsl", amount: 2 } }],
  });
  assert.equal(liftedDmb.completeness, "partial");

  const sysDmb = liftArm64SystemEffects({
    instructionId: "inst_1",
    mnemonic: "dmb",
    ops: [{ k: "imm", value: 15n, shift: { op: "lsl", amount: 2 } }],
  });
  assert.equal(sysDmb.completeness, "partial");
}

// Issue #2365: nonEmpty and sortedStrings string validation
{
  assert.throws(() => createArtifactId({
    binaryId: "bin_1",
    loaderVersion: "1.0",
    architectureSemanticVersion: "1.0",
    abiSemanticVersion: "1.0",
    semanticSchemaVersion: "1.0",
    passId: "pass",
    inputArtifactIds: [123],
  }), TypeError);

  assert.throws(() => createEvidenceId({
    binaryId: 123,
    identity: { key: "val" },
  }), TypeError);
}

// Issue #2363: alias result idList string validation
{
  assert.throws(() => createAliasResult({
    relation: "must",
    status: { completeness: "complete" },
    reasonCodes: ["identical-root-and-exact-offset"],
    evidenceIds: [123],
  }), TypeError);
}

console.log("Batch 2 tests passed!");
