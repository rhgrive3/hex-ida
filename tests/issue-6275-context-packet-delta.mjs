import assert from "node:assert/strict";
import test from "node:test";
import { createDevContextPacket } from "../js/ai/dev/protocol/context-packet.js";
import { selectDevContext } from "../js/ai/dev/protocol/context-selection.js";

const basePacketInput = {
  taskId: "t1",
  objective: "investigate",
};

test("issue #6275 - createDevContextPacket preserves normalized contextDelta", () => {
  const packet = createDevContextPacket({
    ...basePacketInput,
    contextDelta: [
      "delta statement 1",
      { statement: "delta statement 2", source: "worker", authority: "owning-system" },
    ],
  });

  assert.equal(packet.contextDelta.length, 2);
  assert.equal(packet.contextDelta[0].statement, "delta statement 1");
  assert.equal(packet.contextDelta[0].authority, "worker-reported-evidence");

  // Worker-supplied authority is not elevated
  assert.equal(packet.contextDelta[1].statement, "delta statement 2");
  assert.equal(packet.contextDelta[1].authority, "worker-reported-evidence");
});

test("issue #6275 - selectDevContext selects contextDelta from packet", () => {
  const packet = createDevContextPacket({
    ...basePacketInput,
    contextDelta: [
      { statement: "delta observation", source: "worker" },
    ],
  });

  const selected = selectDevContext({ packet });
  assert.equal(selected.packet.contextDelta.length, 1);
  assert.equal(selected.packet.contextDelta[0].statement, "delta observation");
});

test("issue #6275 - malformed or empty contextDelta item is rejected", () => {
  assert.throws(
    () => createDevContextPacket({ ...basePacketInput, contextDelta: [""] }),
    TypeError,
    "Should reject empty string in contextDelta"
  );
  assert.throws(
    () => createDevContextPacket({ ...basePacketInput, contextDelta: [null] }),
    TypeError,
    "Should reject null in contextDelta"
  );
});
