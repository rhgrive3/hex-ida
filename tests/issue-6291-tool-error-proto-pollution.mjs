import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeDevToolArguments } from "../js/ai/dev/supervisor/tool-error-recovery.js";

test("issue #6291 - sanitizeDevToolArguments does not permit prototype injection via __proto__", () => {
  const jsonWithProto = JSON.parse(`{"__proto__": {"polluted": true}, "normal": "safe", "secret": "supersecret"}`);
  const sanitized = sanitizeDevToolArguments(jsonWithProto);

  // Prototype must remain Object.prototype, not the injected object
  assert.equal(Object.getPrototypeOf(sanitized), Object.prototype);
  assert.equal(({}).polluted, undefined);
  assert.equal(sanitized.polluted, undefined);

  // Own __proto__ property is defined safely
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, "__proto__"), true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(sanitized, "__proto__").value, { polluted: true });

  // Normal and sensitive keys are handled properly
  assert.equal(sanitized.normal, "safe");
  assert.equal(sanitized.secret, "[redacted]");
});

test("issue #6291 - nested prototype injection is prevented", () => {
  const nested = JSON.parse(`{"nested": {"__proto__": {"injected": 123}, "token": "abc"}}`);
  const sanitized = sanitizeDevToolArguments(nested);

  assert.equal(Object.getPrototypeOf(sanitized.nested), Object.prototype);
  assert.equal(({}).injected, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized.nested, "__proto__"), true);
  assert.equal(sanitized.nested.token, "[redacted]");
});

test("issue #6291 - truncation and depth limits are preserved", () => {
  const deep = { a: { b: { c: { d: "deep" } } } };
  const sanitizedDeep = sanitizeDevToolArguments(deep);
  assert.equal(sanitizedDeep.a.b.c, "[object]");

  const manyKeys = {};
  for (let i = 0; i < 30; i++) manyKeys[`k${i}`] = i;
  const sanitizedMany = sanitizeDevToolArguments(manyKeys);
  assert.equal(sanitizedMany["[truncated]"], true);
  assert.equal(Object.keys(sanitizedMany).length, 25); // 24 keys + [truncated]
});
