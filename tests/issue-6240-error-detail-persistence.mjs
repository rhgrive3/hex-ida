import assert from "node:assert/strict";
import test from "node:test";
import { serializeConversation, reviveConversation, MAX_PERSISTED_ERROR } from "../js/ai/ui/conversations.js";

test("issue #6240 - assistant error turn keeps bounded error detail across serialize/revive", () => {
  const conversation = {
    id: "c-6240",
    title: "",
    createdAt: 1000,
    updatedAt: 2000,
    mode: "chat",
    style: "analyst",
    scope: "function",
    provider: "mock",
    model: "mock",
    reasoning: null,
    lastQuestion: "この関数を説明して",
    turns: [
      { role: "user", text: "この関数を説明して", mode: "chat", style: "analyst", scope: "function", at: 1100 },
      { role: "assistant", status: "error", error: "AI service failed (503).", text: "", mode: "chat", style: "analyst", scope: "function", at: 1200 },
    ],
  };

  const serialized = serializeConversation(conversation);
  const errorRecord = serialized.turns[1];
  assert.equal(errorRecord.status, "error");
  assert.equal(errorRecord.error, "AI service failed (503).");

  const revived = reviveConversation(JSON.parse(JSON.stringify(serialized)), "test");
  const restoredTurn = revived.turns[1];
  assert.equal(restoredTurn.status, "error");
  assert.equal(restoredTurn.error, "AI service failed (503).");
});

test("issue #6240 - non-error turns do not gain an error field", () => {
  const conversation = {
    id: "c-6240b",
    title: "",
    createdAt: 1000,
    updatedAt: 2000,
    turns: [
      { role: "user", text: "q", mode: "chat", style: "analyst", scope: "auto", at: 1100 },
      { role: "assistant", status: "done", text: "answer", mode: "chat", style: "analyst", scope: "auto", at: 1200 },
      { role: "assistant", status: "cancelled", text: "", mode: "chat", style: "analyst", scope: "auto", at: 1300 },
    ],
  };

  const serialized = serializeConversation(conversation);
  assert.ok(!("error" in serialized.turns[0]));
  assert.ok(!("error" in serialized.turns[1]));
  assert.ok(!("error" in serialized.turns[2]));

  const revived = reviveConversation(JSON.parse(JSON.stringify(serialized)), "test");
  assert.equal(revived.turns[1].status, "done");
  assert.equal(revived.turns[1].error, null);
  assert.equal(revived.turns[2].status, "cancelled");
  assert.equal(revived.turns[2].error, null);
});

test("issue #6240 - oversized error detail is truncated to the bounded limit", () => {
  const conversation = {
    id: "c-6240c",
    title: "",
    createdAt: 1000,
    updatedAt: 2000,
    turns: [
      { role: "assistant", status: "error", error: "x".repeat(MAX_PERSISTED_ERROR * 4), text: "", mode: "chat", style: "analyst", scope: "auto", at: 1200 },
    ],
  };

  const serialized = serializeConversation(conversation);
  assert.equal(serialized.turns[0].error.length, MAX_PERSISTED_ERROR);

  const revived = reviveConversation(JSON.parse(JSON.stringify(serialized)), "test");
  assert.equal(revived.turns[0].error.length, MAX_PERSISTED_ERROR);
});

test("issue #6240 - restored error status without stored detail still revives safely", () => {
  const legacy = {
    id: "c-6240d",
    title: "",
    createdAt: 1000,
    updatedAt: 2000,
    turns: [
      { role: "assistant", status: "error", text: "", mode: "chat", style: "analyst", scope: "auto", at: 1200 },
    ],
  };

  const revived = reviveConversation(legacy, "test");
  assert.equal(revived.turns[0].status, "error");
  assert.equal(revived.turns[0].error, null);
});
