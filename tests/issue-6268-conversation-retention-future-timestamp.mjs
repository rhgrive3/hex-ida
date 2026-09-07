import assert from "node:assert/strict";
import test from "node:test";
import { AiSession } from "../js/ai/ui/session.js";

function createMockPlatform() {
  return {
    selection: { provider: "mock", model: "mock", reasoning: "none" },
    namespace: "test",
    storage: null,
  };
}

test("issue #6268 - new conversation is never evicted even with future timestamps on restored chats", () => {
  const session = new AiSession(createMockPlatform());

  // Fill up to max restored limit with conversations having future timestamps
  const futureTimestamp = Date.now() + 10000000;
  for (let i = 0; i < 22; i++) {
    const conv = session.newConversation();
    conv.updatedAt = futureTimestamp + i;
    conv.turns.push({ role: "user", text: "hi" }, { role: "assistant", text: "hello" });
  }

  // Now create a new conversation whose updatedAt is now (older than futureTimestamp)
  const newlyCreated = session.newConversation();

  // Invariant: current must always be in conversations
  assert.equal(session.current, newlyCreated);
  assert.ok(session.conversations.includes(newlyCreated));
  assert.equal(session.get(newlyCreated.id), newlyCreated);
  assert.ok(session.list().includes(newlyCreated));
});
