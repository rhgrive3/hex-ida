import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createDecisionCache } from "../jev-context/core/decision-cache.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jev-test-9654-"));
}

// 1. Two writers load the same empty cache, add different digests, save sequentially, and both digests remain
{
  const tmp = makeTempDir();
  const cachePath = path.join(tmp, "decisions.json");
  const w1 = createDecisionCache({ path: cachePath, policyVersion: "v1" });
  const w2 = createDecisionCache({ path: cachePath, policyVersion: "v1" });
  w1.load();
  w2.load();

  w1.set("digest-w1", { action: "drop", confidence: 0.9 });
  w2.set("digest-w2", { action: "keep", confidence: 0.8 });

  w1.save();
  w2.save();

  const verifyCache = createDecisionCache({ path: cachePath, policyVersion: "v1" });
  assert.equal(verifyCache.get("digest-w1")?.a, "drop");
  assert.equal(verifyCache.get("digest-w2")?.a, "keep");
  console.log("PASS 1: two writers save sequentially, both digests remain");
}

// 2. Reverse save order also preserves both digests
{
  const tmp = makeTempDir();
  const cachePath = path.join(tmp, "decisions.json");
  const w1 = createDecisionCache({ path: cachePath, policyVersion: "v1" });
  const w2 = createDecisionCache({ path: cachePath, policyVersion: "v1" });
  w1.load();
  w2.load();

  w1.set("digest-a", { action: "drop" });
  w2.set("digest-b", { action: "keep" });

  // Reverse save order: w2 first, then w1
  w2.save();
  w1.save();

  const verifyCache = createDecisionCache({ path: cachePath, policyVersion: "v1" });
  assert.equal(verifyCache.get("digest-a")?.a, "drop");
  assert.equal(verifyCache.get("digest-b")?.a, "keep");
  console.log("PASS 2: reverse save order preserves both digests");
}

// 3. Three stale writers all preserve their unique digests
{
  const tmp = makeTempDir();
  const cachePath = path.join(tmp, "decisions.json");
  const w1 = createDecisionCache({ path: cachePath, policyVersion: "v1" });
  const w2 = createDecisionCache({ path: cachePath, policyVersion: "v1" });
  const w3 = createDecisionCache({ path: cachePath, policyVersion: "v1" });
  w1.load();
  w2.load();
  w3.load();

  w1.set("digest-1", { action: "drop" });
  w2.set("digest-2", { action: "keep" });
  w3.set("digest-3", { action: "drop" });

  w1.save();
  w2.save();
  w3.save();

  const verifyCache = createDecisionCache({ path: cachePath, policyVersion: "v1" });
  assert.equal(verifyCache.get("digest-1")?.a, "drop");
  assert.equal(verifyCache.get("digest-2")?.a, "keep");
  assert.equal(verifyCache.get("digest-3")?.a, "drop");
  console.log("PASS 3: three stale writers preserve all unique digests");
}

// 4. Same-process independent cache instances are safe
{
  const tmp = makeTempDir();
  const cachePath = path.join(tmp, "decisions.json");
  const instances = Array.from({ length: 5 }, () => createDecisionCache({ path: cachePath, policyVersion: "v1" }));
  for (const inst of instances) inst.load();

  instances.forEach((inst, i) => inst.set(`inst-${i}`, { action: "keep", confidence: i * 0.1 }));
  for (const inst of instances) inst.save();

  const verifyCache = createDecisionCache({ path: cachePath, policyVersion: "v1" });
  for (let i = 0; i < 5; i++) {
    assert.equal(verifyCache.get(`inst-${i}`)?.a, "keep");
  }
  console.log("PASS 4: same-process independent cache instances are safe");
}

// 5. Separate-process writers are safe
{
  const tmp = makeTempDir();
  const cachePath = path.join(tmp, "decisions.json");
  const moduleUrl = new URL("../jev-context/core/decision-cache.mjs", import.meta.url).href;

  const script = (key) => `
    import { createDecisionCache } from ${JSON.stringify(moduleUrl)};
    const cache = createDecisionCache({ path: ${JSON.stringify(cachePath)}, policyVersion: "v1" });
    cache.load();
    cache.set(${JSON.stringify(key)}, { action: "drop", reason: ${JSON.stringify(key)} });
    cache.save();
  `;

  const runChild = (key) => new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, ["--input-type=module", "-e", script(key)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    cp.stderr.on("data", (chunk) => (err += chunk));
    cp.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`child ${key} failed: ${err}`))));
  });

  await Promise.all([
    runChild("proc-a"),
    runChild("proc-b"),
    runChild("proc-c"),
  ]);

  const verifyCache = createDecisionCache({ path: cachePath, policyVersion: "v1" });
  assert.equal(verifyCache.get("proc-a")?.r, "proc-a");
  assert.equal(verifyCache.get("proc-b")?.r, "proc-b");
  assert.equal(verifyCache.get("proc-c")?.r, "proc-c");
  console.log("PASS 5: separate-process writers are safe");
}

// 6. Same digest written by two writers resolves deterministically without corrupting unrelated entries
{
  const tmp = makeTempDir();
  const cachePath = path.join(tmp, "decisions.json");
  const w1 = createDecisionCache({ path: cachePath, policyVersion: "v1" });
  const w2 = createDecisionCache({ path: cachePath, policyVersion: "v1" });
  w1.load();
  w2.load();

  w1.set("shared-digest", { action: "keep", reason: "from-w1" });
  w1.set("w1-only", { action: "drop" });

  w2.set("shared-digest", { action: "drop", reason: "from-w2" });
  w2.set("w2-only", { action: "keep" });

  w1.save();
  w2.save();

  const verifyCache = createDecisionCache({ path: cachePath, policyVersion: "v1" });
  assert.equal(verifyCache.get("shared-digest")?.a, "drop");
  assert.equal(verifyCache.get("shared-digest")?.r, "from-w2");
  assert.equal(verifyCache.get("w1-only")?.a, "drop");
  assert.equal(verifyCache.get("w2-only")?.a, "keep");
  console.log("PASS 6: same digest resolves deterministically without corrupting other entries");
}

// 7. Merged state respects maxEntries
{
  const tmp = makeTempDir();
  const cachePath = path.join(tmp, "decisions.json");
  const w1 = createDecisionCache({ path: cachePath, policyVersion: "v1", maxEntries: 3 });
  const w2 = createDecisionCache({ path: cachePath, policyVersion: "v1", maxEntries: 3 });
  w1.load();
  w2.load();

  w1.set("item-1", { action: "drop" });
  w1.set("item-2", { action: "drop" });
  w1.save();

  w2.set("item-3", { action: "drop" });
  w2.set("item-4", { action: "drop" });
  w2.save();

  const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  const keys = Object.keys(raw.entries);
  assert.equal(keys.length, 3, "merged state must not exceed maxEntries 3");
  assert.deepEqual(keys, ["item-2", "item-3", "item-4"], "oldest entry item-1 should be evicted");
  console.log("PASS 7: merged state respects maxEntries");
}

// 8. A writer encountering a corrupt cache still follows existing fail-open semantics
{
  const tmp = makeTempDir();
  const cachePath = path.join(tmp, "decisions.json");
  fs.writeFileSync(cachePath, "{corrupt json content!@#$", { mode: 0o600 });

  const writer = createDecisionCache({ path: cachePath, policyVersion: "v1" });
  writer.set("recovered-digest", { action: "keep" });
  const saveResult = writer.save();
  assert.equal(saveResult.saved, true, "save must succeed despite prior corrupt cache");

  const verifyCache = createDecisionCache({ path: cachePath, policyVersion: "v1" });
  assert.equal(verifyCache.get("recovered-digest")?.a, "keep");
  console.log("PASS 8: writer encountering corrupt cache follows fail-open semantics");
}

// 9. Temp-file publication remains crash-safe and leaves no half-written JSON
{
  const tmp = makeTempDir();
  const cachePath = path.join(tmp, "decisions.json");
  const writer = createDecisionCache({ path: cachePath, policyVersion: "v1" });
  writer.set("safe-digest", { action: "keep" });
  writer.save();

  const files = fs.readdirSync(tmp);
  const tmpFiles = files.filter(f => f.endsWith(".tmp"));
  assert.equal(tmpFiles.length, 0, "no leftover tmp files after successful save");

  const content = fs.readFileSync(cachePath, "utf8");
  assert.doesNotThrow(() => JSON.parse(content), "cache file must be valid JSON");
  console.log("PASS 9: publication is crash-safe with no leftover tmp files");
}

// 10. After a successful merged save, the saving instance's in-memory summary matches the committed generation
{
  const tmp = makeTempDir();
  const cachePath = path.join(tmp, "decisions.json");
  const w1 = createDecisionCache({ path: cachePath, policyVersion: "v1" });
  const w2 = createDecisionCache({ path: cachePath, policyVersion: "v1" });
  w1.load();
  w2.load();

  w1.set("d-one", { action: "drop" });
  w1.save();

  w2.set("d-two", { action: "keep" });
  w2.save();

  const summary = w2.summary();
  assert.equal(summary.size, 2, "saving instance in-memory size must reflect the 2 merged entries");
  assert.equal(w2.get("d-one")?.a, "drop", "saving instance must be able to get d-one");
  assert.equal(w2.get("d-two")?.a, "keep", "saving instance must be able to get d-two");
  console.log("PASS 10: saving instance in-memory summary matches committed generation");
}

console.log("All 10 tests for issue #9654 passed!");
