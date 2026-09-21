import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  installAgy,
  installCodex,
  installOpenCode,
  openCodePluginShimPath,
  uninstallAgy,
  uninstallCodex,
  uninstallOpenCode,
} from "../jev-context/adapters/install.mjs";

function temp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("OpenCode reinstall refuses a user-replaced shim when an older backup exists", () => {
  const root = temp("jev-9394-");
  try {
    const shim = openCodePluginShimPath(root);
    fs.mkdirSync(path.dirname(shim), { recursive: true });
    fs.writeFileSync(shim, "// original-before-jev\n");
    installOpenCode({ root });
    assert.equal(fs.readFileSync(`${shim}.before-jev-prune`, "utf8"), "// original-before-jev\n");

    fs.writeFileSync(shim, "// important-new-user-plugin\n");
    assert.throws(
      () => installOpenCode({ root }),
      /OpenCode shim was replaced by non-managed content/,
    );
    assert.equal(fs.readFileSync(shim, "utf8"), "// important-new-user-plugin\n");
    assert.equal(fs.readFileSync(`${shim}.before-jev-prune`, "utf8"), "// original-before-jev\n");

    const result = uninstallOpenCode({ root });
    assert.equal(result.removed, false);
    assert.equal(fs.readFileSync(shim, "utf8"), "// important-new-user-plugin\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode managed shim reinstall remains idempotent", () => {
  const root = temp("jev-9394-managed-");
  try {
    const first = installOpenCode({ root });
    const shim = first.file;
    const before = fs.readFileSync(shim, "utf8");
    installOpenCode({ root });
    assert.equal(fs.readFileSync(shim, "utf8"), before);
    assert.equal(fs.existsSync(`${shim}.before-jev-prune`), false);
    const result = uninstallOpenCode({ root });
    assert.equal(result.removed, true);
    assert.equal(fs.existsSync(shim), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex uninstall removes only exact installer-owned entries", () => {
  const home = temp("jev-9397-codex-");
  try {
    installCodex({ codexHome: home });
    const file = path.join(home, "hooks.json");
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    const collisionTop = { command: "node /opt/tools/jev-context-audit.mjs" };
    const collisionNested = { hooks: [{ type: "command", command: "node /opt/keep.mjs --tag jev-context", timeout: 5, async: true }] };
    config.hooks.SessionStart.push(collisionTop, collisionNested);
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");

    const result = uninstallCodex({ codexHome: home });
    assert.ok(result.removed.includes("SessionStart"));
    const next = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(next.hooks.SessionStart, [collisionTop, collisionNested]);
    assert.equal(next.hooks.SessionEnd, undefined);
    assert.equal(next.hooks.PostToolUse, undefined);

    const again = uninstallCodex({ codexHome: home });
    assert.deepEqual(again.removed, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Agy substring collisions do not block install or get removed", () => {
  const home = temp("jev-9397-agy-");
  try {
    const file = path.join(home, "config", "hooks.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const collision = { hooks: [{ command: "node /tmp/jev-context-audit.mjs" }] };
    fs.writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [collision] } }, null, 2) + "\n");

    const installed = installAgy({ geminiHome: home });
    assert.ok(installed.added.includes("SessionStart"), "substring collision must not count as an installed JEV hook");

    uninstallAgy({ geminiHome: home });
    const next = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(next.hooks.SessionStart, [collision]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
