import assert from "node:assert/strict";
import test from "node:test";
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
