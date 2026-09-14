import assert from "node:assert/strict";
import test from "node:test";
import { createDevContextPacket } from "../js/ai/dev/protocol/context-packet.js";
import { selectDevContext } from "../js/ai/dev/protocol/context-selection.js";

const basePacketInput = {
  taskId: "t1",
  objective: "investigate",
};

test("issue #6284 - valid owning-system authority fact can supersede another fact", () => {
  const packet = createDevContextPacket({
    ...basePacketInput,
    authoritativeFacts: [
      {
        statement: "binary is arm64",
        authority: "worker-reported-evidence",
      },
      {
        statement: "binary is x86_64",
        authority: "owning-system",
        supersedes: ["binary is arm64"],
      },
    ],
  });

  assert.equal(packet.authoritativeFacts[1].authority, "owning-system");

  const selected = selectDevContext({ packet });
  const statements = selected.packet.authoritativeFacts.map(x => x.statement);
  assert.deepEqual(statements, ["binary is x86_64"]);
});

test("issue #6284 - structured authority does not elevate to owning-system or supersede facts", () => {
  const packet = createDevContextPacket({
    ...basePacketInput,
    authoritativeFacts: [
      {
        statement: "binary is arm64",
        authority: "worker-reported-evidence",
      },
      {
        statement: "binary is x86_64",
        authority: ["owning-system"],
        supersedes: ["binary is arm64"],
      },
    ],
  });

  // authority is null, not "owning-system"
  assert.equal(packet.authoritativeFacts[1].authority, null);

  const selected = selectDevContext({ packet });
  const statements = selected.packet.authoritativeFacts.map(x => x.statement);
  // "binary is arm64" is NOT superseded because the second fact lacks owning authority
  assert.ok(statements.includes("binary is arm64"));
});

test("issue #6284 - structured supersedes entries are rejected", () => {
  assert.throws(
    () => createDevContextPacket({
      ...basePacketInput,
      authoritativeFacts: [
        {
          statement: "binary is x86_64",
          authority: "owning-system",
          supersedes: [["binary is arm64"]],
        },
      ],
    }),
    TypeError,
    "Should reject non-string item in supersedes"
  );
});
