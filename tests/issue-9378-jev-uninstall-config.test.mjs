import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { uninstallAgy, uninstallCodex } from "../jev-context/adapters/install.mjs";

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hex-9378-${name}-`));
}

test("#9378 Codex uninstall preserves malformed config bytes and fails closed", () => {
  const home = tempDir("codex-malformed");
  try {
    const file = path.join(home, "hooks.json");
    const original = '{"hooks":{"SessionStart":[{"command":"important-user-hook"}]';
    fs.writeFileSync(file, original);
    assert.throws(
      () => uninstallCodex({ codexHome: home }),
      /malformed host hook config/,
    );
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.equal(fs.existsSync(`${file}.before-jev-prune`), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("#9378 Agy uninstall preserves malformed config bytes and fails closed", () => {
  const home = tempDir("agy-malformed");
  try {
    const file = path.join(home, "config", "hooks.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = '{"hooks":{"PostToolUse":[{"command":"important-user-hook"}]';
    fs.writeFileSync(file, original);
    assert.throws(
      () => uninstallAgy({ geminiHome: home }),
      /malformed host hook config/,
    );
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.equal(fs.existsSync(`${file}.before-jev-prune`), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("#9378 missing hook configs stay absent and uninstall is idempotent", () => {
  const codexHome = tempDir("codex-missing");
  const agyHome = tempDir("agy-missing");
  try {
    const codexFile = path.join(codexHome, "hooks.json");
    const agyFile = path.join(agyHome, "config", "hooks.json");
    assert.deepEqual(uninstallCodex({ codexHome }).removed, []);
    assert.deepEqual(uninstallAgy({ geminiHome: agyHome }).removed, []);
    assert.equal(fs.existsSync(codexFile), false);
    assert.equal(fs.existsSync(agyFile), false);
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(agyHome, { recursive: true, force: true });
  }
});

test("#9378 valid config without JEV-owned entries is not rewritten", () => {
  const home = tempDir("no-owned-entry");
  try {
    const file = path.join(home, "hooks.json");
    const original = '{"other":true,"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo keep"}]}]}}\n';
    fs.writeFileSync(file, original);
    const result = uninstallCodex({ codexHome: home });
    assert.deepEqual(result.removed, []);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.equal(fs.existsSync(`${file}.before-jev-prune`), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("#9378 valid config removes only JEV-owned hooks and creates a recovery backup", () => {
  const home = tempDir("owned-entry");
  try {
    const file = path.join(home, "hooks.json");
    const originalObject = {
      other: true,
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "echo keep" }] },
          { hooks: [{ type: "command", command: "/usr/bin/node /tmp/jev-context/adapters/codex/hooks.mjs" }] },
        ],
        ForeignEvent: [{ hooks: [{ type: "command", command: "echo foreign" }] }],
      },
    };
    const original = `${JSON.stringify(originalObject, null, 2)}\n`;
    fs.writeFileSync(file, original);

    const result = uninstallCodex({ codexHome: home });
    assert.deepEqual(result.removed, ["SessionStart"]);
    assert.ok(result.backup);
    assert.equal(fs.readFileSync(result.backup, "utf8"), original);

    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.other, true);
    assert.equal(after.hooks.SessionStart.length, 1);
    assert.equal(after.hooks.SessionStart[0].hooks[0].command, "echo keep");
    assert.equal(after.hooks.ForeignEvent[0].hooks[0].command, "echo foreign");
    assert.ok(!JSON.stringify(after).includes("jev-context"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
