import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runPhase4Tests } from "../run.mjs";

const PHASE4_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNERSHIP_ROOT = path.join(PHASE4_ROOT, "ownership");

test("Phase 4 waits for the child node:test process before independent oracles", async () => {
  let childExited = false;
  let oracleStarted = false;

  const result = await runPhase4Tests([], {
    root: OWNERSHIP_ROOT,
    spawn(execPath, args, options) {
      assert.equal(execPath, process.execPath);
      assert.equal(args[0], "--test");
      assert.ok(args.includes("--test-concurrency=1"));
      const files = args.filter((arg) => arg.endsWith(".test.mjs"));
      assert.ok(files.length > 0);
      assert.ok(files.every((file) => file.endsWith(".test.mjs")));
      assert.equal(options.cwd, path.resolve(OWNERSHIP_ROOT, "../.."));
      childExited = true;
      return { status: 0 };
    },
    runVerification: async () => {
      assert.equal(childExited, true, "independent oracles must run after child test completion");
      oracleStarted = true;
      return { verificationCases: [], rawFailures: {} };
    },
  });

  assert.equal(oracleStarted, true);
  assert.equal(result.selected, result.total);
});
