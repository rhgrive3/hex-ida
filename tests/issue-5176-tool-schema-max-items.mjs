// Regression for #5176: sanitizeToolSchema()'s allowed keyword set omitted
// `maxItems`, so a browser-side tool contract "arrays have at most N items"
// disappeared at the worker boundary. The provider saw an unbounded array
// while the browser still enforced the original schema via assertSchema()
// (`invalid_tool_call`), i.e. the provider-visible contract and the local
// enforcement contract diverged for the same tool call.
import assert from 'node:assert/strict';
import { sanitizeToolSchema, normalizeAITools } from '../js/ai/provider/worker-protocol.js';
import { assertSchema } from '../js/ai/validation.js';

const issueSchema = {
  type: 'object',
  properties: {
    xs: { type: 'array', maxItems: 1, items: { type: 'string' } },
  },
  additionalProperties: false,
};

{
  // The issue's exact schema must keep maxItems:1 through sanitization.
  const out = sanitizeToolSchema(issueSchema);
  assert.equal(out.properties.xs.maxItems, 1, 'maxItems must survive the worker-boundary sanitizer');
  assert.deepEqual(out.properties.xs.items, { type: 'string', properties: {} });
  assert.equal(out.properties.xs.type, 'array');
}

{
  // The array-bound keyword must survive at every nesting depth, and the
  // other sibling bound keywords keep flowing through the numeric branch.
  const out = sanitizeToolSchema({
    type: 'object',
    properties: {
      outer: {
        type: 'array', maxItems: 3,
        items: { type: 'object', properties: { inner: { type: 'array', maxItems: 2, items: { type: 'integer', minimum: 0, maximum: 255 } } }, additionalProperties: false },
      },
    },
  });
  assert.equal(out.properties.outer.maxItems, 3);
  assert.equal(out.properties.outer.items.properties.inner.maxItems, 2);
  assert.equal(out.properties.outer.items.properties.inner.items.minimum, 0, 'minimum passes through the numeric branch as-is');
  assert.equal(out.properties.outer.items.properties.inner.items.maximum, 255, 'maximum passes through the numeric branch as-is');
}

{
  // End-to-end via the worker request path: normalizeAITools() forwards the
  // browser ToolRegistry schema to the provider with the array bound intact.
  const tools = normalizeAITools([{ name: 'collect', description: 'collect rows', inputSchema: issueSchema }]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].inputSchema.properties.xs.maxItems, 1, 'provider-visible schema must carry the array bound');
}

{
  // Contract parity: the provider-visible schema and the local enforcement
  // schema must agree — a tool call the provider-visible schema now describes
  // as bounded must be exactly the call the local validator rejects/accepts.
  const visible = sanitizeToolSchema(issueSchema);
  assert.throws(
    () => assertSchema({ xs: ['a', 'b'] }, visible, 'invalid_tool_call'),
    /too many items/,
    'local enforcement must reject what the bounded schema forbids',
  );
  assertSchema({ xs: ['a'] }, visible, 'invalid_tool_call');
}
