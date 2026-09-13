import path from 'node:path';
import { fileURLToPath } from "node:url";

import { runVerificationOracles } from "./verification/oracles.mjs";
import { discoverPhaseTests, runPhaseNodeTests } from "../support/phase-node-test-runner.mjs";

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

export function discoverPhase4Tests(root = DIRECTORY) {
  return discoverPhaseTests(root);
}

export async function runPhase4Tests(
  argv = process.argv.slice(2),
  { root = DIRECTORY, spawn, runVerification = runVerificationOracles } = {},
) {
  const runnerOptions = {
    phase: "phase4",
    root,
    argv,
    cwd: path.resolve(root, "../.."),
  };
  if (spawn) runnerOptions.spawn = spawn;
  const result = runPhaseNodeTests(runnerOptions);

  // Keep the independent Phase 4 product oracles after the child test runner
  // has exited. Importing node:test files only registers tests; it does not
  // prove that their asynchronous bodies have completed.
  const verification = await runVerification();
  console.log("PHASE4_VERIFICATION_ORACLES " + JSON.stringify(verification));
  const failedCases = verification.verificationCases.filter((item) => item.status !== "pass");
  const rawFailures = Object.entries(verification.rawFailures).filter(([, value]) => Number(value) !== 0);
  if (failedCases.length || rawFailures.length) {
    throw new Error(`phase4 independent verification failed: cases=${failedCases.length} raw=${JSON.stringify(Object.fromEntries(rawFailures))}`);
  }

  console.log(`phase4: PASS (${result.selected} test files + independent verification)`);
  return Object.freeze({ ...result, verification });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await runPhase4Tests();
