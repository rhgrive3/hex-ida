import assert from "node:assert/strict";
import { AgentJobManager } from "../js/ai/jobs/index.js";

console.log("Testing Issue #3110 AgentJobManager identity boundaries...");

{
  const runtime = { turn: async () => ({ limits: { exhausted: false }, answer: "done" }) };
  const persistence = { save: async () => {}, load: async () => null };
  const manager = new AgentJobManager({ runtime, persistence });

  // Structured jobId values must fail closed instead of being String()-laundered
  // into a plausible-looking regular id.
  for (const bad of [42, { id: 'job-1' }, ['job-1'], true]) {
    await assert.rejects(
      () => manager.create({ goal: 'g', jobId: bad }),
      (error) => /Agent job id must be a non-empty string/.test(error?.message),
      `jobId ${JSON.stringify(bad)} must be rejected`,
    );
  }

  // get() must not coerce selectors: objects/numbers cannot reach the map.
  assert.equal(await manager.get({ toString: () => 'job-1' }), null);
  assert.equal(await manager.get(7), null);
  assert.equal(await manager.get('missing-id'), null);

  // A real string id still works end to end.
  const job = await manager.create({ goal: 'g', jobId: 'job-1' });
  assert.equal(job.id, 'job-1');
  assert.ok(await manager.get('job-1'));
}

{
  // Evidence/tool identity must stay string-typed: numeric/structured ids that
  // used to be String()-ed into the checkpoint are dropped instead.
  const runtime = { turn: async () => ({ limits: { exhausted: false }, answer: 'done', evidence: [{ id: 99, detailRef: { laundered: true } }], activity: [{ type: 'tool-result', tool: 123 }] }) };
  const persistence = { save: async () => {}, load: async () => null };
  const manager = new AgentJobManager({ runtime, persistence });
  const job = await manager.create({ goal: 'g' });
  await manager.resume(job.id);
  const checkpoint = manager.list().find((item) => item.id === job.id);
  assert.deepEqual(checkpoint.evidenceIds, [], 'numeric evidence id must not be laundered into the checkpoint');
  assert.deepEqual(checkpoint.completedTools, [], 'numeric tool id must not be laundered into the checkpoint');
  assert.deepEqual(checkpoint.continuationRefs, [], 'structured ref must not be laundered into the checkpoint');
}

console.log("issue #3110 agent job identity boundaries: PASS");
