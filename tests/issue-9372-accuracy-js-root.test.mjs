import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { partitionDigest, partitionFiles } from "../scripts/accuracy-partition-cache-key.mjs";

function tempRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hex-9372-${name}-`));
}

test("#9372 rejects a top-level js symlink instead of returning a source-empty cache key", () => {
  const root = tempRoot("symlink");
  const outside = tempRoot("outside");
  try {
    fs.writeFileSync(path.join(outside, "source.js"), "export const value = 1;\n");
    fs.symlinkSync(outside, path.join(root, "js"), "dir");
    assert.throws(() => partitionFiles(root, "core"), /required js root must be a real directory/);
    assert.throws(() => partitionDigest(root, "core"), /required js root must be a real directory/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("#9372 retargeting a top-level js symlink can never remain an accepted digest state", () => {
  const root = tempRoot("retarget");
  const first = tempRoot("first");
  const second = tempRoot("second");
  try {
    fs.writeFileSync(path.join(first, "source.js"), "one\n");
    fs.writeFileSync(path.join(second, "source.js"), "two\n");
    const jsRoot = path.join(root, "js");
    fs.symlinkSync(first, jsRoot, "dir");
    assert.throws(() => partitionDigest(root, "core"), /required js root must be a real directory/);
    fs.unlinkSync(jsRoot);
    fs.symlinkSync(second, jsRoot, "dir");
    assert.throws(() => partitionDigest(root, "core"), /required js root must be a real directory/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test("#9372 rejects missing and broken required js roots", () => {
  const missing = tempRoot("missing");
  const broken = tempRoot("broken");
  try {
    assert.throws(() => partitionFiles(missing, "core"), /required js root is unavailable/);
    fs.symlinkSync(path.join(broken, "does-not-exist"), path.join(broken, "js"), "dir");
    assert.throws(() => partitionFiles(broken, "core"), /required js root must be a real directory/);
  } finally {
    fs.rmSync(missing, { recursive: true, force: true });
    fs.rmSync(broken, { recursive: true, force: true });
  }
});

test("#9372 preserves ordinary real-directory source traversal", () => {
  const root = tempRoot("real");
  try {
    fs.mkdirSync(path.join(root, "js"), { recursive: true });
    fs.writeFileSync(path.join(root, "js", "source.js"), "export const value = 1;\n");
    assert.deepEqual(partitionFiles(root, "core"), ["js/source.js"]);
    const first = partitionDigest(root, "core");
    fs.writeFileSync(path.join(root, "js", "source.js"), "export const value = 2;\n");
    const second = partitionDigest(root, "core");
    assert.notEqual(first, second);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
