import assert from "node:assert/strict";
import test from "node:test";
import { AIRuntime } from "../../../js/ai/runtime.js";
import { sessionMatchesSnapshot } from "../../../js/ai/control/runtime-support.js";

const strongSnapshot = {
  binaryId: "content:aaaaaaaa",
  binaryIdentity: {
    id: "content:aaaaaaaa",
    kind: "content-derived",
    confidence: "strong",
    state: "ready",
    hash: "aaaaaaaa",
  },
  legacyBinaryId: "new.bin:0",
  projectIdentity: null,
  runtimeSessionIdentity: null,
  runtimeSessionState: "unknown",
};

test("issue #6180 - unbound session does not wildcard-match a strong current binary", () => {
  const legacyUnboundSession = {
    id: "old-session",
    binaryId: null,
    binaryIdentity: null,
    projectId: null,
    investigationMemory: { anchor: null },
  };

  assert.equal(sessionMatchesSnapshot(legacyUnboundSession, strongSnapshot), false);
});

test("issue #6180 - unbound session matches only an unbound snapshot", () => {
  const unboundSession = {
    id: "old-session",
    binaryId: null,
    binaryIdentity: null,
    projectId: null,
    investigationMemory: { anchor: null },
  };
  const unboundSnapshot = {
    binaryId: null,
    binaryIdentity: null,
    legacyBinaryId: null,
    projectIdentity: null,
    runtimeSessionIdentity: null,
    runtimeSessionState: "unknown",
  };

  assert.equal(sessionMatchesSnapshot(unboundSession, unboundSnapshot), true);
  assert.equal(sessionMatchesSnapshot(unboundSession, { ...strongSnapshot, binaryId: null, binaryIdentity: null, legacyBinaryId: null }), true);
});

test("issue #6180 - verifiable legacy binding still upgrades to a strong identity", () => {
  const legacySession = {
    id: "legacy-session",
    binaryId: null,
    binaryIdentity: { id: "old.bin:0", kind: "legacy", confidence: "weak", state: "ready", legacyId: "new.bin:0" },
    projectId: null,
    investigationMemory: { anchor: null },
  };

  assert.equal(sessionMatchesSnapshot(legacySession, strongSnapshot), true);
});

test("issue #6180 - strong identity match and mismatch behave as before", () => {
  const boundSession = {
    id: "bound-session",
    binaryId: "content:aaaaaaaa",
    binaryIdentity: strongSnapshot.binaryIdentity,
    projectId: null,
    investigationMemory: { anchor: null },
  };
  const otherSnapshot = {
    ...strongSnapshot,
    binaryId: "content:bbbbbbbb",
    binaryIdentity: { ...strongSnapshot.binaryIdentity, id: "content:bbbbbbbb", hash: "bbbbbbbb" },
    legacyBinaryId: "other.bin:0",
  };

  assert.equal(sessionMatchesSnapshot(boundSession, strongSnapshot), true);
  assert.equal(sessionMatchesSnapshot(boundSession, otherSnapshot), false);
});

test("issue #6180 - explicit unbound session resume rejects before provider or store hydration", async () => {
  let providerCalls = 0;
  const runtime = new AIRuntime({
    context: { binaryHash: "aaaaaaaa", binaryId: "new.bin:0" },
    planner: false,
    provider: {
      async nextTurn() {
        providerCalls++;
        return { type: "final", answer: "must not run", evidenceIds: [], hypotheses: [], suggestedActions: [] };
      },
    },
  });
  const savedEvidence = {
    id: "ev_saved_6180",
    kind: "observation",
    status: "verified",
    title: "old binary finding",
    sourceTool: "deterministic-test",
  };
  const session = runtime.sessionStore.register({
    id: "legacy-unbound-6180",
    binaryId: null,
    binaryIdentity: null,
    projectId: null,
    messages: [{ role: "assistant", content: "old binary conversation" }],
    investigationMemory: { goal: "old goal", anchor: null },
    confirmedFindings: [savedEvidence],
    hypotheses: [{
      id: "hyp_saved_6180",
      claim: "old binary hypothesis",
      confidence: 0.8,
      status: "verified",
      supportEvidenceIds: [savedEvidence.id],
      contradictionEvidenceIds: [],
      missingEvidence: [],
    }],
  });

  await assert.rejects(
    runtime.turn({ sessionId: session.id, mode: "chat", scope: "auto", goal: "resume old session" }),
    (error) => error?.type === "scope_violation",
  );

  assert.equal(providerCalls, 0, "provider must not observe a mismatched persisted session");
  assert.equal(runtime.storeNamespaces.size, 0, "mismatched findings/hypotheses must not hydrate a current-binary namespace");
  assert.equal(runtime.evidenceStore.get(savedEvidence.id), null);
  assert.equal(runtime.hypothesisStore.get("hyp_saved_6180"), null);

  const after = await runtime.sessionStore.get(session.id);
  assert.equal(after.binaryId, null, "rejected session must not be upgraded to the current binary");
  assert.equal(after.binaryIdentity, null);
  assert.deepEqual(after.messages.map((message) => message.content), ["old binary conversation"]);
  assert.equal(after.confirmedFindings.length, 1);
  assert.equal(after.hypotheses.length, 1);
});
