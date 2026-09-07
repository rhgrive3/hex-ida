import assert from "node:assert/strict";
import { AgentJobManager } from "../js/ai/jobs/index.js";

console.log("Testing Issue #2647 AgentJobManager slice save resumption regression...");

{
  let turnCalled = 0;
  const runtime = {
    turn: async () => {
      turnCalled++;
      return { limits: { exhausted: false }, answer: "done" };
    },
  };

  let saves = 0;
  const persistence = {
    save: async (job) => {
      saves++;
      if (saves === 2) {
        throw new Error("disk unavailable");
      }
    },
    load: async () => null,
  };

  const manager = new AgentJobManager({ runtime, persistence });
  const job = await manager.create({ goal: "test-goal", jobId: "job-1" });
  assert.equal(job.status, "ready");
  assert.equal(saves, 1);

  // 1st runSlice: 2nd save() throws "disk unavailable"
  await assert.rejects(
    manager.runSlice(job.id),
    /disk unavailable/
  );

  // job status in memory must have been restored from running back to ready
  const inMemJob = await manager.get(job.id);
  assert.equal(inMemJob.status, "ready", "job.status must not remain running after save failure");
  assert.equal(turnCalled, 0, "runtime.turn must not have been invoked");

  // Subsequent resume / runSlice succeeds because save() will no longer throw
  const resumed = await manager.resume(job.id);
  assert.equal(resumed.status, "complete");
  assert.equal(turnCalled, 1);
}

console.log("Issue #2647 regression PASS!");
