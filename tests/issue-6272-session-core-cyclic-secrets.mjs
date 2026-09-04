import assert from "node:assert/strict";
import test from "node:test";
import { stripSecrets } from "../js/ai/session-core/index.js";

test("issue #6272 - stripSecrets strips secret keys from normal nested objects", () => {
  const normal = {
    name: "test",
    apiKey: "secret-123",
    nested: {
      token: "secret-abc",
      data: 42,
    },
    items: [
      { id: 1, credential: "bad" },
      { id: 2, ok: true },
    ],
  };

  const stripped = stripSecrets(normal);
  assert.equal(stripped.name, "test");
  assert.equal(stripped.apiKey, undefined);
  assert.equal(stripped.nested.data, 42);
  assert.equal(stripped.nested.token, undefined);
  assert.equal(stripped.items[0].credential, undefined);
  assert.equal(stripped.items[1].ok, true);
});

test("issue #6272 - stripSecrets rejects direct cyclic references with TypeError", () => {
  const cyclic = { name: "cyclic" };
  cyclic.self = cyclic;

  assert.throws(
    () => stripSecrets(cyclic),
    TypeError,
    "Should throw TypeError on direct cycle"
  );
});

test("issue #6272 - stripSecrets rejects indirect cyclic references with TypeError", () => {
  const a = { name: "a" };
  const b = { name: "b", parent: a };
  a.child = b;

  assert.throws(
    () => stripSecrets(a),
    TypeError,
    "Should throw TypeError on indirect cycle"
  );
});

test("issue #6272 - stripSecrets allows shared non-cyclic sibling objects", () => {
  const shared = { value: "hello" };
  const container = {
    first: shared,
    second: shared,
  };

  const result = stripSecrets(container);
  assert.equal(result.first.value, "hello");
  assert.equal(result.second.value, "hello");
});
