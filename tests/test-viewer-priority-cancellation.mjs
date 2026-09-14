import assert from "node:assert/strict";
import { Backend } from "../js/backend.js";
import { VariableInstructionIndex } from "../js/viewer/variable-instruction-index.js";

console.log("Testing Issues #2603 and #2605 regressions...");

// ── 1. Issue #2603: Chunk request priority scheduling ──
{
  const backend = new Backend();

  // Fill MAX_INFLIGHT (6) with fake in-flight jobs
  for (let i = 0; i < 6; i++) {
    backend.inflight.set(backend.key("r1", i), {
      regionId: "r1", chunk: i, wantAsm: false, priority: "visible", key: backend.key("r1", i), gen: 1
    });
  }

  // Queue prefetch jobs
  backend.request("r1", 10, false, { priority: "prefetch" });
  backend.request("r1", 11, false, { priority: "prefetch" });
  backend.request("r1", 12, false, { priority: "prefetch" });

  assert.equal(backend.queue.length, 3);
  assert.equal(backend.queue[0].chunk, 10);
  assert.equal(backend.queue[1].chunk, 11);
  assert.equal(backend.queue[2].chunk, 12);

  // Now a visible viewport job arrives
  backend.request("r1", 20, false, { priority: "visible" });

  // Visible job (chunk 20) must be prioritized ahead of prefetch jobs (10, 11, 12)
  assert.equal(backend.queue.length, 4);
  assert.equal(backend.queue[0].chunk, 20, "Visible request must be placed ahead of prefetch queue");
  assert.equal(backend.queue[1].chunk, 10);

  // Another visible job
  backend.request("r1", 21, false, { priority: "visible" });
  assert.equal(backend.queue[1].chunk, 21, "Second visible request must follow first visible request");
  assert.equal(backend.queue[2].chunk, 10);

  // Upgrade prefetch chunk 11 to visible
  backend.request("r1", 11, false, { priority: "visible" });
  const qChunks = backend.queue.map((j) => j.chunk);
  assert.deepEqual(qChunks, [20, 21, 11, 10, 12], "Upgraded job must be moved ahead of prefetch jobs");

  backend.dispose();
}

// ── 2. Issue #2605: Variable viewer AbortSignal & priority propagation ──
{
  const backend = new Backend();
  const recordedOptions = [];

  const mockDisassembleAt = async (address, options = {}) => {
    recordedOptions.push({ address, ...options });
    if (options.signal?.aborted) {
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    }
    return {
      supported: true,
      architecture: options.architecture,
      instructions: [
        { address: BigInt(address), size: 4, mnemonic: "nop", opStr: "", bytes: new Uint8Array([0x90, 0x90, 0x90, 0x90]) }
      ],
      bytesRead: 4,
    };
  };

  const region = { vmAddr: 0x1000n, size: 0x2000n, end: 0x3000n, id: "code" };
  const varIndex = new VariableInstructionIndex({
    disassembleAt: mockDisassembleAt,
    architecture: "x86_64",
  });
  varIndex.configureRegion(region);

  // Ensure page with priority: prefetch
  await varIndex.ensurePage(0x1000n, { priority: "prefetch" });
  assert.equal(recordedOptions[0].priority, "prefetch", "Priority must be passed to disassembleAt");

  // Ensure page with AbortSignal
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    varIndex.ensurePage(0x1100n, { signal: controller.signal, priority: "current" }),
    { name: "AbortError" }
  );

  backend.dispose();
}

console.log("Issues #2603 and #2605 regression tests PASS!");
