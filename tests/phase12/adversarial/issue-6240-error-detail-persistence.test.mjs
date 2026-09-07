import assert from "node:assert/strict";
import test from "node:test";
import { renderTurn } from "../../../js/ai/render/message.js";
import { serializeConversation, reviveConversation, MAX_PERSISTED_ERROR } from "../../../js/ai/ui/conversations.js";

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
  assert.equal(renderErrorDetail(conversation.turns[1]), "AI service failed (503).");
  assert.equal(renderErrorDetail(restoredTurn), renderErrorDetail(conversation.turns[1]));
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

// Match the repository's Node renderer fixtures, while restoring the global DOM
// descriptor so Phase 12's shared-process discovery cannot leak this fixture.
function renderErrorDetail(turn) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const document = {
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(), className: "", textContent: "", dataset: {},
        childNodes: [], attributes: {}, listeners: new Map(),
        append(...nodes) { this.childNodes.push(...nodes); },
        setAttribute(name, value) { this.attributes[name] = String(value); },
        addEventListener(type, listener) { this.listeners.set(type, listener); },
      };
    },
  };
  Object.defineProperty(globalThis, "document", { value: document, writable: true, configurable: true });
  try {
    const root = renderTurn(turn, { onRetry() {} });
    const alert = root.childNodes.find((node) => node.attributes.role === "alert");
    assert.ok(alert, "the production renderer must retain its error alert");
    const detail = alert.childNodes.find((node) => node.className.split(/\s+/).includes("ai-error-detail"));
    assert.ok(detail, "the production renderer must contain the diagnostic line");
    return detail.textContent;
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else delete globalThis.document;
  }
}

test("issue #6240 - truncation preserves complete surrogate pairs without widening the storage cap", () => {
  for (const [input, expected] of [
    ["x".repeat(398) + "😀", "x".repeat(398) + "😀"],
    ["x".repeat(399) + "😀", "x".repeat(399)],
    ["x".repeat(400) + "😀", "x".repeat(400)],
    ["😀".repeat(201), "😀".repeat(200)],
    ["診断".repeat(200) + "追加", "診断".repeat(200)],
  ]) {
    const original = { id: "unicode", turns: [{
      role: "assistant", status: "error", mode: "chat", style: "analyst",
      scope: "function", text: "", error: input,
    }] };
    const saved = serializeConversation(original);
    const revived = reviveConversation(JSON.parse(JSON.stringify(saved)), "unicode");
    const direct = reviveConversation(original, "unicode");
    for (const turn of [saved.turns[0], revived.turns[0], direct.turns[0]]) {
      assert.equal(turn.error, expected);
      assert.ok(turn.error.length <= MAX_PERSISTED_ERROR);
      assert.equal(turn.error.isWellFormed(), true, "truncation must not create a lone surrogate");
      assert.equal(renderErrorDetail(turn), expected);
    }
  }
});
