import assert from "node:assert/strict";
import test from "node:test";

import { createFunctionSummary, createMemoryEffect } from "../../js/analysis/summary/contract.js";
import { solveInterproceduralSummaries } from "../../js/analysis/summary/interprocedural.js";
import { createAnalysisStatus } from "../../js/analysis/status.js";

const completeStatus = () => createAnalysisStatus({
  snapshotId: "snapshot_summary_corpus",
  analyzerId: "phase7.summary.local",
  analyzerVersion: "1.0.0",
  completeness: "complete",
});

test("issue #2641: broad memory write does not silently drop specific tls write under cap=1", () => {
  const localA = createFunctionSummary({
    functionId: "fn_a",
    directCalls: [{ callSiteId: "call_fn_callee", targetEntityIds: ["fn_callee"], effectSource: "abi-rule" }],
    status: completeStatus(),
    memoryWriteRegions: [
      createMemoryEffect({
        regionKind: "unknown",
        broad: true,
        addressSpaces: ["memory"],
        source: "unknown-call-fallback",
      }),
    ],
  });

  const localCallee = createFunctionSummary({
    functionId: "fn_callee",
    directCalls: [],
    status: completeStatus(),
    memoryWriteRegions: [
      createMemoryEffect({
        regionId: "tls:slot",
        regionKind: "tls",
        broad: false,
        addressSpaces: ["tls"],
        source: "proven-summary",
      }),
    ],
  });

  const locals = new Map([
    ["fn_a", localA],
    ["fn_callee", localCallee],
  ]);

  const solved = solveInterproceduralSummaries({
    roots: ["fn_a"],
    localSummaries: locals,
    budget: { maxEffectsPerSummary: 1 },
  });

  const summary = solved.summaries.get("fn_a");
  assert.ok(summary, "fn_a summary must be produced");
  assert.equal(summary.memoryWriteRegions.length, 1, "must have 1 collapsed broad effect under cap=1");

  const effect = summary.memoryWriteRegions[0];
  assert.equal(effect.broad, true, "collapsed effect must be broad");
  assert.ok(effect.addressSpaces.includes("memory"), "must cover memory addressSpace");
  assert.ok(effect.addressSpaces.includes("tls"), "must cover tls addressSpace to preserve soundness");
});

test("issue #2641: specific effect subsumption only occurs when broad encompasses all specific address spaces", () => {
  const localA = createFunctionSummary({
    functionId: "fn_a",
    directCalls: [],
    status: completeStatus(),
    memoryWriteRegions: [
      createMemoryEffect({
        regionKind: "unknown",
        broad: true,
        addressSpaces: ["memory", "tls"],
        source: "unknown-call-fallback",
      }),
      createMemoryEffect({
        regionId: "tls:slot",
        regionKind: "tls",
        broad: false,
        addressSpaces: ["tls"],
        source: "proven-summary",
      }),
      createMemoryEffect({
        regionId: "global:0x1000",
        regionKind: "global-absolute",
        broad: false,
        addressSpaces: ["memory"],
        source: "proven-summary",
      }),
    ],
  });

  const locals = new Map([["fn_a", localA]]);

  const solved = solveInterproceduralSummaries({
    roots: ["fn_a"],
    localSummaries: locals,
    budget: { maxEffectsPerSummary: 1 },
  });

  const summary = solved.summaries.get("fn_a");
  assert.equal(summary.memoryWriteRegions.length, 1);
  assert.equal(summary.memoryWriteRegions[0].broad, true);
  assert.deepEqual(summary.memoryWriteRegions[0].addressSpaces, ["memory", "tls"]);
});

test("issue #2641: un-broad specific effects collapse to broad covering all active address spaces when exceeding cap", () => {
  const localA = createFunctionSummary({
    functionId: "fn_a",
    directCalls: [],
    status: completeStatus(),
    memoryWriteRegions: [
      createMemoryEffect({
        regionId: "tls:slot1",
        regionKind: "tls",
        broad: false,
        addressSpaces: ["tls"],
        source: "proven-summary",
      }),
      createMemoryEffect({
        regionId: "io:port0",
        regionKind: "io-port",
        broad: false,
        addressSpaces: ["io"],
        source: "proven-summary",
      }),
    ],
  });

  const locals = new Map([["fn_a", localA]]);

  const solved = solveInterproceduralSummaries({
    roots: ["fn_a"],
    localSummaries: locals,
    budget: { maxEffectsPerSummary: 1 },
  });

  const summary = solved.summaries.get("fn_a");
  assert.equal(summary.memoryWriteRegions.length, 1);
  assert.equal(summary.memoryWriteRegions[0].broad, true);
  assert.deepEqual(summary.memoryWriteRegions[0].addressSpaces, ["io", "tls"]);
});

test("issue #2641: cap <= 0 normalized safely to effectiveCap >= 1 (preserves #1873)", () => {
  const localA = createFunctionSummary({
    functionId: "fn_a",
    directCalls: [],
    status: completeStatus(),
    memoryWriteRegions: [
      createMemoryEffect({
        regionKind: "unknown",
        broad: true,
        addressSpaces: ["memory"],
        source: "unknown-call-fallback",
      }),
    ],
  });

  const locals = new Map([["fn_a", localA]]);

  const solved = solveInterproceduralSummaries({
    roots: ["fn_a"],
    localSummaries: locals,
    budget: { maxEffectsPerSummary: 0 },
  });

  const summary = solved.summaries.get("fn_a");
  assert.equal(summary.memoryWriteRegions.length, 1);
  assert.equal(summary.memoryWriteRegions[0].broad, true);
});
