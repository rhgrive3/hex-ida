import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createSessionStore } from "../jev-context/adapters/hooks/protocol.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jev-test-9652-"));
}

const tmpDir = makeTempDir();
const storePath = path.join(tmpDir, "sessions.json");

// 1. remember("__proto__", entry) persists an own session key
{
  const store = createSessionStore({ path: storePath });
  const entry = { digest: "d_proto_1", tool: "read" };
  const items = store.remember("__proto__", entry);
  assert.equal(items.length, 1);
  assert.equal(items[0].digest, "d_proto_1");

  const raw = fs.readFileSync(storePath, "utf8");
  const parsed = JSON.parse(raw);
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, "__proto__"), "persisted JSON must contain own property __proto__");
  assert.equal(parsed["__proto__"][0].digest, "d_proto_1");
  console.log("PASS 1: remember(\"__proto__\", entry) persists an own session key");
}

// 2. A fresh store can recent("__proto__") and recover the entry
{
  const freshStore = createSessionStore({ path: storePath });
  const items = freshStore.recent("__proto__");
  assert.equal(items.length, 1);
  assert.equal(items[0].digest, "d_proto_1");
  console.log("PASS 2: fresh store recent(\"__proto__\") recovers entry");
}

// 3. digestCounts("__proto__") recovers the prior digest count across processes
{
  const freshStore = createSessionStore({ path: storePath });
  const counts = freshStore.digestCounts("__proto__");
  assert.equal(counts.get("d_proto_1"), 1);
  console.log("PASS 3: digestCounts(\"__proto__\") recovers prior count across stores");
}

// 4. constructor is treated as an opaque session ID, not an inherited property
{
  const store = createSessionStore({ path: storePath });
  assert.deepEqual(store.recent("constructor"), [], "empty constructor session returns [] not Object");
  store.remember("constructor", { digest: "d_ctor" });
  assert.equal(store.recent("constructor").length, 1);
  assert.equal(store.recent("constructor")[0].digest, "d_ctor");
  console.log("PASS 4: constructor treated as opaque session ID");
}

// 5. toString is treated as an opaque session ID
{
  const store = createSessionStore({ path: storePath });
  assert.deepEqual(store.recent("toString"), [], "empty toString session returns [] not function");
  store.remember("toString", { digest: "d_tostr" });
  assert.equal(store.recent("toString").length, 1);
  assert.equal(store.recent("toString")[0].digest, "d_tostr");
  console.log("PASS 5: toString treated as opaque session ID");
}

// 6. A normal session ID retains current persistence behavior
{
  const store = createSessionStore({ path: storePath });
  store.remember("session-abc", { digest: "d_abc" });
  assert.equal(store.recent("session-abc").length, 1);
  assert.equal(store.recent("session-abc")[0].digest, "d_abc");
  console.log("PASS 6: normal session ID retains persistence behavior");
}

// 7. Multiple special-name sessions remain isolated from one another
{
  const store = createSessionStore({ path: storePath });
  assert.equal(store.recent("__proto__")[0].digest, "d_proto_1");
  assert.equal(store.recent("constructor")[0].digest, "d_ctor");
  assert.equal(store.recent("toString")[0].digest, "d_tostr");
  assert.equal(store.recent("session-abc")[0].digest, "d_abc");
  console.log("PASS 7: special-name sessions remain isolated");
}

// 8. Existing on-disk JSON using normal session IDs remains readable
{
  const legacyPath = path.join(tmpDir, "legacy.json");
  fs.writeFileSync(legacyPath, JSON.stringify({
    default: [{ digest: "d_default", at: 1000 }],
    "normal-session": [{ digest: "d_norm", at: 2000 }],
  }));
  const legacyStore = createSessionStore({ path: legacyPath });
  assert.equal(legacyStore.recent("default").length, 1);
  assert.equal(legacyStore.recent("default")[0].digest, "d_default");
  assert.equal(legacyStore.recent("normal-session").length, 1);
  assert.equal(legacyStore.recent("normal-session")[0].digest, "d_norm");
  console.log("PASS 8: existing on-disk JSON remains readable");
}

// 9. maxItems truncation still applies to special-name sessions
{
  const boundedPath = path.join(tmpDir, "bounded.json");
  const store = createSessionStore({ path: boundedPath, maxItems: 3 });
  store.remember("__proto__", { digest: "item1" });
  store.remember("__proto__", { digest: "item2" });
  store.remember("__proto__", { digest: "item3" });
  store.remember("__proto__", { digest: "item4" });
  const recent = store.recent("__proto__");
  assert.equal(recent.length, 3);
  assert.deepEqual(recent.map(i => i.digest), ["item2", "item3", "item4"]);
  console.log("PASS 9: maxItems truncation applies to special-name sessions");
}

// 10. Concurrent-writer locking behavior remains unchanged after key-representation fix
{
  const lockStorePath = path.join(tmpDir, "concurrent-sessions.json");
  const lockPath = `${lockStorePath}.lock`;
  const readyPath = path.join(tmpDir, "child-ready");
  fs.writeFileSync(lockPath, `${process.pid} ${Date.now()}\n`, { mode: 0o600 });

  const protocolUrl = pathToFileURL(path.resolve("jev-context/adapters/hooks/protocol.mjs")).href;
  const script = [
    `import fs from "node:fs";`,
    `import { createSessionStore } from ${JSON.stringify(protocolUrl)};`,
    `fs.writeFileSync(process.env.READY_PATH, "ready");`,
    `createSessionStore({ path: process.env.STORE_PATH }).remember("__proto__", { digest: "child-proto" });`,
  ].join("\n");

  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, STORE_PATH: lockStorePath, READY_PATH: readyPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));

  const deadline = Date.now() + 2000;
  while (!fs.existsSync(readyPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(fs.existsSync(readyPath), "child writer did not reach lock in time");

  fs.writeFileSync(lockStorePath, JSON.stringify({
    ["__proto__"]: [{ digest: "parent-proto", at: Date.now() }],
  }), { mode: 0o600 });
  fs.unlinkSync(lockPath);

  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, `concurrent writer failed: ${stderr}`);

  const store = createSessionStore({ path: lockStorePath });
  const entries = store.recent("__proto__");
  assert.deepEqual(
    entries.map((e) => e.digest).sort(),
    ["child-proto", "parent-proto"],
    "concurrent writer must reload and preserve state committed before it acquired lock",
  );
  console.log("PASS 10: concurrent-writer locking behavior remains unchanged");
}

console.log("All 10 tests for issue #9652 passed!");
