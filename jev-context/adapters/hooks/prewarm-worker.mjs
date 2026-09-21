#!/usr/bin/env node
import { createPipeline } from "../../core/pipeline.mjs";
import { readHookInput } from "./protocol.mjs";

/**
 * Detached background classifier.
 *
 * The hook handler spawns this process with `detached: true` and `unref()`s it,
 * then answers the host immediately. That is what keeps OpenJEV latency off the
 * critical path for hosts whose only extension point is a lifecycle hook: the
 * tool call returns at once, and the decision lands in the shared cache for the
 * next model request.
 *
 * The job is passed on stdin. Nothing is echoed to stdout or stderr (the parent
 * ignores both anyway) and no credential is ever included in the job payload
 * beyond what the engine itself redacts.
 */
async function main() {
  let job = {};
  try {
    job = await readHookInput();
  } catch {
    process.exit(0);
  }

  try {
    const pipeline = createPipeline();
    if (!pipeline.config.usable) process.exit(0);

    const rawItems = Array.isArray(job.items) ? job.items : [];
    if (rawItems.length === 0) process.exit(0);

    await pipeline.prewarm(rawItems, {
      scope: job.scope || "hook",
      taskText: job.taskText || "",
      writeTime: job.writeTime === true,
      mode: job.mode || pipeline.config.mode,
      // An array of [digest, count] pairs: JSON has no Map.
      priorDigests: Array.isArray(job.priorDigests) ? new Map(job.priorDigests) : null,
    });
    pipeline.saveState();
  } catch {
    // A background failure is invisible by design.
  }
  process.exit(0);
}

main();
