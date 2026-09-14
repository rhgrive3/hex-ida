import assert from "node:assert/strict";
import { shouldEnforceGeneratedOutput, generatedOutputMode, GENERATED_OUTPUT_MODE } from "../tools/validation/generated-output-policy.mjs";
import { validateProviderOutput, importPhase12Package } from "../js/phase12/package-envelope.js";
import { RemoteProtocolClient } from "../js/debug/remote-protocol.js";
import { DEBUG_PROTOCOL_VERSION } from "../js/debug/adapter.js";

// Issue #2302: invalid branch name fails closed to ENFORCE
{
  assert.equal(generatedOutputMode({ eventName: "pull_request", headRef: "dev-agent-hardening/../main" }), GENERATED_OUTPUT_MODE.ENFORCE);
  assert.equal(generatedOutputMode({ eventName: "pull_request", headRef: "dev-agent-hardening/valid-branch" }), GENERATED_OUTPUT_MODE.EPHEMERAL);
}

// Issue #2271: reject unknown fields in validateProviderOutput
{
  const res = validateProviderOutput({
    schemaVersion: "phase12-provider-output/v1",
    provenance: { source: "test" },
    completeness: "complete",
    items: [],
    unknownField: "bad",
  });
  assert.equal(res.ok, false);
}

// Issue #2300: reject stale response with mismatched epoch
{
  let sent;
  const transport = {
    async send(p) { sent = p; },
    subscribe() {},
    close() {},
  };
  const client = new RemoteProtocolClient(transport);
  client.setEpoch(2);
  const req = client.request("testMethod", {}, { epoch: 2 });
  // Send response with epoch 1
  const handledStale = client.receive({
    version: DEBUG_PROTOCOL_VERSION,
    type: "response",
    id: sent.id,
    epoch: 1,
    result: { ok: true },
  });
  assert.equal(handledStale, false);
  // Send valid response
  const handledValid = client.receive({
    version: DEBUG_PROTOCOL_VERSION,
    type: "response",
    id: sent.id,
    epoch: 2,
    result: { value: 42 },
  });
  assert.equal(handledValid, true);
  const res = await req;
  assert.equal(res.value, 42);
}

console.log("Batch 3 tests passed!");
