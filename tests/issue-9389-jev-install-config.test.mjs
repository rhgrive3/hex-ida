import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installAgy, installCodex } from "../jev-context/adapters/install.mjs";

function temp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("Codex install refuses malformed host config without mutation", () => {
  const home = temp("jev-9389-codex-");
  try {
    const file = path.join(home, "hooks.json");
    const original = '{"hooks":{"SessionStart":[{"command":"important-user-hook"}]';
    fs.writeFileSync(file, original);
    assert.throws(() => installCodex({ codexHome: home }), /malformed host hook config/);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.equal(fs.existsSync(`${file}.before-jev-prune`), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Agy install refuses malformed and non-object host config without mutation", () => {
  for (const original of ["{bad-json", "[]", "null"]) {
    const home = temp("jev-9389-agy-");
    try {
      const file = path.join(home, "config", "hooks.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, original);
      assert.throws(() => installAgy({ geminiHome: home }), /host hook config/);
      assert.equal(fs.readFileSync(file, "utf8"), original);
      assert.equal(fs.existsSync(`${file}.before-jev-prune`), false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test("missing and valid configs retain install behavior", () => {
  const codex = temp("jev-9389-missing-");
  const agy = temp("jev-9389-valid-");
  try {
    const created = installCodex({ codexHome: codex });
    assert.deepEqual(created.added.sort(), ["PostToolUse", "SessionEnd", "SessionStart"]);
    const createdJson = JSON.parse(fs.readFileSync(path.join(codex, "hooks.json"), "utf8"));
    assert.ok(createdJson.hooks.SessionStart);

    const agyFile = path.join(agy, "config", "hooks.json");
    fs.mkdirSync(path.dirname(agyFile), { recursive: true });
    fs.writeFileSync(agyFile, JSON.stringify({
      custom: { keep: true },
      hooks: { SessionStart: [{ command: "important-user-hook" }] },
    }));
    const result = installAgy({ geminiHome: agy });
    assert.ok(result.added.includes("SessionStart"));
    const next = JSON.parse(fs.readFileSync(agyFile, "utf8"));
    assert.deepEqual(next.custom, { keep: true });
    assert.equal(next.hooks.SessionStart[0].command, "important-user-hook");
  } finally {
    fs.rmSync(codex, { recursive: true, force: true });
    fs.rmSync(agy, { recursive: true, force: true });
  }
});
