import test from "node:test";
import assert from "node:assert/strict";
import { AiSession } from "../js/ai/ui/session.js";
import {
  createConversationStore,
  serializeConversation,
  reviveConversation,
  MAX_PERSISTED_TURNS,
} from "../js/ai/ui/conversations.js";
import { renderAssistantTurn } from "../js/ai/render/message.js";

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    dump: () => map,
  };
}

test("1. live session error turn can be retried as before", async () => {
  let attempt = 0;
  const session = new AiSession({
    engine: {
      async run(input) {
        attempt++;
        if (attempt === 1) throw new Error("network_error");
        return { answer: "success on retry: " + input.question };
      },
    },
    storage: null,
  });

  const firstTurn = await session.ask("live question", { context: {} });
  assert.equal(firstTurn.status, "error");
  assert.equal(session.turns.length, 2);

  const retried = await session.retry({ context: {} });
  assert.equal(retried.status, "done");
  assert.equal(retried.response.answerText, "success on retry: live question");
  assert.equal(session.turns.length, 2);
  assert.equal(session.turns[0].text, "live question");
  assert.equal(session.turns[1], retried);
});

test("2. serialize -> revive restored error turn can be retried even with lastQuestion null", async () => {
  let attempt = 0;
  const storage = memoryStorage();
  const store = createConversationStore({ namespace: "test-ns", storage });

  const session1 = new AiSession({
    engine: {
      async run() {
        attempt++;
        throw new Error("provider_timeout");
      },
    },
    storage: store,
  });

  await session1.ask("この関数を説明して", { context: {} });
  session1.flushSave();

  // Restore as if fresh page load
  const session2 = new AiSession({
    engine: {
      async run(input) {
        return { answer: "復元後の回答: " + input.question };
      },
    },
    storage: createConversationStore({ namespace: "test-ns", storage }),
  });

  // Switch to restored conversation
  const restored = session2.conversations.find((c) => c.turns.length > 0);
  assert.ok(restored, "must have restored conversation");
  session2.switchTo(restored);

  // Directly simulate raw revival where lastQuestion is null
  restored.lastQuestion = null;
  assert.equal(restored.turns.at(-2).text, "この関数を説明して");
  assert.equal(restored.turns.at(-1).status, "error");

  const errorTurn = restored.turns.at(-1);
  const retried = await session2.retry({ context: {}, targetTurn: errorTurn });
  assert.ok(retried, "retry must return new turn");
  assert.equal(retried.status, "done");
  assert.equal(retried.response.answerText, "復元後の回答: この関数を説明して");
  assert.equal(session2.turns.length, 2);
  assert.equal(session2.turns[0].text, "この関数を説明して");
  assert.equal(session2.turns[1], retried);
});

test("3. after retry, the failed user+assistant pair is replaced, no duplicate question in transcript", async () => {
  let attempt = 0;
  const session = new AiSession({
    engine: {
      async run(input) {
        attempt++;
        if (attempt === 1) throw new Error("crash");
        return { answer: "ok" };
      },
    },
    storage: null,
  });

  await session.ask("first q", { context: {} });
  assert.equal(session.turns.length, 2);
  const userTurn1 = session.turns[0];

  const retried = await session.retry({ context: {} });
  assert.equal(session.turns.length, 2);
  assert.notEqual(session.turns[0].id, userTurn1.id);
  assert.equal(session.turns[0].text, "first q");
  assert.equal(session.turns[1], retried);
});

test("4. multi-turn conversation retries the matching user question immediately preceding the error turn", async () => {
  let attempt = 0;
  const session = new AiSession({
    engine: {
      async run(input) {
        attempt++;
        if (attempt === 2) throw new Error("second failed");
        return { answer: "answer to " + input.question };
      },
    },
    storage: null,
  });

  await session.ask("turn 1 question", { context: {} });
  assert.equal(session.turns.length, 2);

  await session.ask("turn 2 question", { context: {} });
  assert.equal(session.turns.length, 4);
  assert.equal(session.turns[3].status, "error");

  const retried = await session.retry({ context: {} });
  assert.equal(session.turns.length, 4);
  assert.equal(session.turns[0].text, "turn 1 question");
  assert.equal(session.turns[1].response.answerText, "answer to turn 1 question");
  assert.equal(session.turns[2].text, "turn 2 question");
  assert.equal(session.turns[3], retried);
  assert.equal(retried.response.answerText, "answer to turn 2 question");
});

test("5. switching conversations does not retry a different conversation last question", async () => {
  const session = new AiSession({
    engine: {
      async run(input) {
        if (input.question === "c2-failing") throw new Error("fail");
        return { answer: "ans: " + input.question };
      },
    },
    storage: null,
  });

  // Conversation 1: successful
  await session.ask("c1-success", { context: {} });
  const c1 = session.current;

  // Conversation 2: failing
  const c2 = session.newConversation();
  await session.ask("c2-failing", { context: {} });
  assert.equal(c2.turns[1].status, "error");

  // Switch back and forth
  session.switchTo(c1.id);
  assert.equal(session.lastQuestion, "c1-success");

  session.switchTo(c2.id);
  assert.equal(session.lastQuestion, "c2-failing");

  // Retry on c2 must retry c2-failing, not c1-success
  session.engine.run = async (input) => ({ answer: "recovered: " + input.question });
  const retried = await session.retry({ context: {} });
  assert.equal(retried.response.answerText, "recovered: c2-failing");
});

test("6. cancelled turn does not have retry UI in render AssistantTurn", () => {
  const turn = {
    id: "a1",
    role: "assistant",
    status: "cancelled",
    mode: "chat",
    style: "beginner",
    text: "",
    activity: [],
  };

  let retryClicked = false;
  const handlers = {
    onRetry: () => { retryClicked = true; },
    onAction: () => {},
    onFollowup: () => {},
    onVerify: () => {},
    proposalsFor: () => [],
  };

  // Mock document/element if in node environment
  globalThis.document = {
    createElement(tag) {
      const el = {
        tagName: tag.toUpperCase(),
        className: "",
        children: [],
        attributes: {},
        dataset: {},
        textContent: "",
        setAttribute(k, v) { this.attributes[k] = v; },
        append(...kids) {
          for (const k of kids) {
            if (typeof k === "string") this.textContent += k;
            else this.children.push(k);
          }
        },
        classList: { add(c) { el.className += " " + c; } },
      };
      return el;
    },
  };

  const rendered = renderAssistantTurn(turn, handlers);
  // Ensure no Retry button exists for cancelled turn
  const hasRetryButton = JSON.stringify(rendered).includes("Retry") || JSON.stringify(rendered).includes("もう一度");
  assert.equal(hasRetryButton, false);
});

test("7. MAX_PERSISTED_TURNS boundary where user turn is missing from transcript fails safe", async () => {
  const session = new AiSession({
    engine: {
      async run() { return { answer: "ok" }; },
    },
    storage: null,
  });

  // Manually construct an orphaned assistant error turn (user turn truncated away)
  session.current.turns = [
    { id: "a-orphan", role: "assistant", status: "error", error: "lost-user", text: "" },
  ];
  session.current.lastQuestion = null;

  const res = await session.retry({ context: {} });
  assert.equal(res, null, "retry must fail-safe and return null when matching user turn cannot be found");
});
