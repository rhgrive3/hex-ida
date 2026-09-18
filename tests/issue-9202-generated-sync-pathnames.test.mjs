import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowFile = path.join(root, '.github/workflows/generated-sync.yml');

function extractCheckScript() {
  const content = fs.readFileSync(workflowFile, 'utf8');
  // Match the run block under "Reject unexpected build side effects"
  const match = /name:\s*Reject unexpected build side effects[\s\S]*?run:\s*\|\n([\s\S]*?)(?=\n\s*- name:)/.exec(content);
  assert.ok(match, 'could not find Reject unexpected build side effects run block');
  return match[1];
}

function runCheckScript(cwd) {
  const script = extractCheckScript();
  try {
    const stdout = execFileSync('bash', ['-c', script], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      ok: false,
      status: err.status,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

function initGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-sync-test-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });

  fs.mkdirSync(path.join(dir, 'userscript'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'userscript/hex.user.template.js'), '// template\n');
  fs.writeFileSync(path.join(dir, 'userscript/release-version.json'), '{"version": 1}\n');

  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
  return dir;
}

test('#9202 generated-sync accepts exact modifications to allowlisted outputs', () => {
  const dir = initGitRepo();
  try {
    fs.appendFileSync(path.join(dir, 'userscript/hex.user.template.js'), '// change\n');
    fs.appendFileSync(path.join(dir, 'userscript/release-version.json'), '{"version": 2}\n');

    const result = runCheckScript(dir);
    assert.equal(result.ok, true, `expected ok, got stderr: ${result.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#9202 generated-sync rejects ordinary unexpected files', () => {
  const dir = initGitRepo();
  try {
    fs.writeFileSync(path.join(dir, 'userscript/unexpected.js'), 'bad');
    const result = runCheckScript(dir);
    assert.equal(result.ok, false);
    assert.match(result.stderr, /userscript:build changed files outside the generated-output allowlist:/);
    assert.match(result.stderr, /userscript\/unexpected\.js/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#9202 generated-sync rejects whitespace bypass: hex.user.template.js extra', () => {
  const dir = initGitRepo();
  try {
    const bypassPath = 'userscript/hex.user.template.js extra';
    fs.writeFileSync(path.join(dir, bypassPath), 'bypass');
    const result = runCheckScript(dir);
    assert.equal(result.ok, false, 'must reject whitespace-appended template file');
    assert.match(result.stderr, /userscript\/hex\.user\.template\.js extra/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#9202 generated-sync rejects whitespace bypass: release-version.json extra', () => {
  const dir = initGitRepo();
  try {
    const bypassPath = 'userscript/release-version.json extra';
    fs.writeFileSync(path.join(dir, bypassPath), 'bypass');
    const result = runCheckScript(dir);
    assert.equal(result.ok, false, 'must reject whitespace-appended release-version file');
    assert.match(result.stderr, /userscript\/release-version\.json extra/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#9202 generated-sync rejects paths with tabs and special characters without truncation', () => {
  const dir = initGitRepo();
  try {
    const specialPath = 'userscript/foo\tbar with spaces.js';
    fs.writeFileSync(path.join(dir, specialPath), 'special');
    const result = runCheckScript(dir);
    assert.equal(result.ok, false);
    assert.match(result.stderr, /userscript\/foo\tbar with spaces\.js/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#9202 generated-sync rejects rename outside allowlist', () => {
  const dir = initGitRepo();
  try {
    execFileSync('git', ['mv', 'userscript/hex.user.template.js', 'userscript/renamed.js'], { cwd: dir });
    const result = runCheckScript(dir);
    assert.equal(result.ok, false);
    assert.match(result.stderr, /userscript\/renamed\.js/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
