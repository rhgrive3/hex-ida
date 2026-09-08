import assert from "node:assert/strict";
import test from "node:test";
import { createDevContextPacket } from "../js/ai/dev/protocol/context-packet.js";
import { selectDevContext } from "../js/ai/dev/protocol/context-selection.js";

const basePacketInput = {
  taskId: "t1",
  objective: "investigate",
};

const statementsOf = (selection) => selection.packet.authoritativeFacts.map((fact) => fact.statement);

test("issue #5427 - one-directional supersession still drops only the loser", () => {
  const packet = createDevContextPacket({
    ...basePacketInput,
    authoritativeFacts: [
      { statement: "main=A", authority: "owning-system", supersedes: ["main=B"] },
      { statement: "main=B", authority: "owning-system" },
    ],
  });
  const selection = selectDevContext({ packet });
  assert.deepEqual(statementsOf(selection), ["main=A"]);
  assert.deepEqual(selection.supersededFacts.map((fact) => fact.statement), ["main=B"]);
  assert.equal(selection.blocker, null);
});

test("issue #5427 - mutual supersession cycle keeps both facts (no silent wipe)", () => {
  const packet = createDevContextPacket({
    ...basePacketInput,
    authoritativeFacts: [
      { statement: "main=A", authority: "owning-system", supersedes: ["main=B"] },
      { statement: "main=B", authority: "owning-system", supersedes: ["main=A"] },
    ],
  });
  const selection = selectDevContext({ packet });
  assert.deepEqual(statementsOf(selection).sort(), ["main=A", "main=B"]);
  assert.deepEqual(selection.supersededFacts, []);
  // The contradiction stays inspectable: both kept facts still declare it.
  const kept = selection.packet.authoritativeFacts;
  assert.deepEqual(kept[0].supersedes, ["main=B"]);
  assert.deepEqual(kept[1].supersedes, ["main=A"]);
});

test("issue #5427 - self-supersession does not remove the only fact", () => {
  const packet = createDevContextPacket({
    ...basePacketInput,
    authoritativeFacts: [
      { statement: "main=A", authority: "owning-system", supersedes: ["main=A"] },
    ],
  });
  const selection = selectDevContext({ packet });
  assert.deepEqual(statementsOf(selection), ["main=A"]);
  assert.deepEqual(selection.supersededFacts, []);
});

test("issue #5427 - three-node cycle keeps every member", () => {
  const packet = createDevContextPacket({
    ...basePacketInput,
    authoritativeFacts: [
      { statement: "main=A", authority: "owning-system", supersedes: ["main=B"] },
      { statement: "main=B", authority: "owning-system", supersedes: ["main=C"] },
      { statement: "main=C", authority: "owning-system", supersedes: ["main=A"] },
    ],
  });
  const selection = selectDevContext({ packet });
  assert.deepEqual(statementsOf(selection).sort(), ["main=A", "main=B", "main=C"]);
  assert.deepEqual(selection.supersededFacts, []);
});

test("issue #5427 - external winner kills a cycle member; the rest stay visible", () => {
  const packet = createDevContextPacket({
    ...basePacketInput,
    authoritativeFacts: [
      { statement: "main=FINAL", authority: "owning-system", supersedes: ["main=A"] },
      { statement: "main=A", authority: "owning-system", supersedes: ["main=B"] },
      { statement: "main=B", authority: "owning-system", supersedes: ["main=A"] },
    ],
  });
  const selection = selectDevContext({ packet });
  // FINAL kills A; A is gone, so its kill of B no longer stands -> B survives.
  assert.deepEqual(statementsOf(selection).sort(), ["main=B", "main=FINAL"]);
  assert.deepEqual(selection.supersededFacts.map((fact) => fact.statement), ["main=A"]);
});

test("issue #5427 - superseded killer no longer suppresses its victim (chain)", () => {
  const packet = createDevContextPacket({
    ...basePacketInput,
    authoritativeFacts: [
      { statement: "main=C", authority: "owning-system", supersedes: ["main=B"] },
      { statement: "main=B", authority: "owning-system", supersedes: ["main=A"] },
      { statement: "main=A", authority: "owning-system" },
    ],
  });
  const selection = selectDevContext({ packet });
  // C kills B. B is dead, so B's kill of A lapses: A stays as the surviving
  // counter-claim instead of vanishing with its dead winner.
  assert.deepEqual(statementsOf(selection).sort(), ["main=A", "main=C"]);
  assert.deepEqual(selection.supersededFacts.map((fact) => fact.statement), ["main=B"]);
});

test("issue #5427 - non-owning declarations still never suppress anything", () => {
  const packet = createDevContextPacket({
    ...basePacketInput,
    authoritativeFacts: [
      { statement: "worker claims stale", authority: "worker-reported-evidence", supersedes: ["owning lease table"] },
      { statement: "owning lease table", authority: "owning-system" },
    ],
  });
  const selection = selectDevContext({ packet });
  assert.deepEqual(statementsOf(selection).sort(), ["owning lease table", "worker claims stale"]);
});

test("issue #5427 - cycle survival is independent of the optional-tier budget", () => {
  const packet = createDevContextPacket({
    ...basePacketInput,
    authoritativeFacts: [
      { statement: "main=A", authority: "owning-system", supersedes: ["main=B"] },
      { statement: "main=B", authority: "owning-system", supersedes: ["main=A"] },
    ],
    dependencyResults: [
      { taskId: "dep-1", state: "failed", summary: "x".repeat(400) },
    ],
  });
  const selection = selectDevContext({ packet, budgetBytes: 700 });
  // Correctness-critical facts are never dropped for budget, cycles included.
  assert.deepEqual(statementsOf(selection).sort(), ["main=A", "main=B"]);
  assert.deepEqual(selection.supersededFacts, []);
});
