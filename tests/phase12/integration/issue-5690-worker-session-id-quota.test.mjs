// Regression for #5690: AI Worker accepted sessionId up to 200 characters,
// but quota layers silently truncated it to 128 characters, causing distinct
// sessions sharing the first 128 characters to collide in per-session quota buckets.
// Worker request boundary must reject sessionId exceeding 128 characters with 422.
import assert from "node:assert/strict";
import { normalizeAITurnRequest } from "../../../js/ai/provider/worker-protocol.js";
import { quotaSessionId } from "../../../js/ai/provider/worker-transport.js";

const baseRequest = {
  mode: "chat",
  style: "analyst",
  scope: "auto",
  context: { request: { goal: "investigate session id quota boundary" } },
  messages: [],
  tools: [],
};

// 1. Valid sessionId <= 128 characters is accepted as-is
{
  const id128 = "s".repeat(128);
  const normalized = normalizeAITurnRequest({ ...baseRequest, sessionId: id128 });
  assert.equal(normalized.sessionId, id128);
  assert.equal(quotaSessionId(normalized.sessionId), id128);

  const shortId = "session-test-123";
  const normShort = normalizeAITurnRequest({ ...baseRequest, sessionId: shortId });
  assert.equal(normShort.sessionId, shortId);
  assert.equal(quotaSessionId(normShort.sessionId), shortId);
}

// 2. Missing, null, or empty string sessionId normalizes to null (anonymous)
{
  assert.equal(normalizeAITurnRequest({ ...baseRequest }).sessionId, null);
  assert.equal(normalizeAITurnRequest({ ...baseRequest, sessionId: null }).sessionId, null);
  assert.equal(normalizeAITurnRequest({ ...baseRequest, sessionId: "" }).sessionId, null);
  assert.equal(quotaSessionId(null), "anonymous");
  assert.equal(quotaSessionId(""), "anonymous");
}

// 3. Reject sessionId exceeding 128 characters with 422 invalid_session_id
{
  const prefix = "x".repeat(128);
  const sessionA = prefix + "A"; // 129 chars
  const sessionB = prefix + "B"; // 129 chars

  assert.throws(
    () => normalizeAITurnRequest({ ...baseRequest, sessionId: sessionA }),
    (err) => {
      assert.equal(err.status, 422);
      assert.equal(err.code, "invalid_session_id");
      assert.match(err.message, /128/);
      return true;
    },
    "must reject 129-char sessionId with 422 invalid_session_id"
  );

  assert.throws(
    () => normalizeAITurnRequest({ ...baseRequest, sessionId: sessionB }),
    (err) => {
      assert.equal(err.status, 422);
      assert.equal(err.code, "invalid_session_id");
      assert.match(err.message, /128/);
      return true;
    },
    "must reject 129-char sessionId with 422 invalid_session_id"
  );
}

// 4. Reject non-string sessionId with 422 invalid_session_id
{
  for (const malformed of [12345, true, {}, ["session-array"]]) {
    assert.throws(
      () => normalizeAITurnRequest({ ...baseRequest, sessionId: malformed }),
      (err) => {
        assert.equal(err.status, 422);
        assert.equal(err.code, "invalid_session_id");
        return true;
      },
      `must reject non-string sessionId (${JSON.stringify(malformed)}) with 422 invalid_session_id`
    );
  }
}

// 5. Metamorphic quota isolation: Any two valid distinct sessionIds must produce distinct quotaSessionIds
{
  const distinctIds = [
    "a",
    "b",
    "x".repeat(127) + "1",
    "x".repeat(127) + "2",
    "x".repeat(128),
    "y".repeat(128),
  ];

  const quotaIds = new Set();
  for (const id of distinctIds) {
    const normalized = normalizeAITurnRequest({ ...baseRequest, sessionId: id });
    const quotaKey = quotaSessionId(normalized.sessionId);
    assert.ok(!quotaIds.has(quotaKey), `quotaSessionId collision detected for ${id}`);
    quotaIds.add(quotaKey);
  }
}

console.log("issue #5690 worker session id quota boundary regressions PASS");
