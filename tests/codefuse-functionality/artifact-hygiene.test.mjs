// Artifact hygiene and provenance contract for the CodeFuse lane.
//
// Committed evidence must describe the measurement, not the machine that ran
// it, and it must name a tree that actually reproduces it. Both properties have
// already been violated once (absolute compiler paths leaked into per-case
// records; the probe recorded a HEAD that predated the harness it ran), so they
// are enforced here rather than by convention.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  summarizeDiagnostics,
  stripHostRoot,
} from '../../reports/investigations/codefuse-functionality/harness/compile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const LANE_DIR = path.join(REPO_ROOT, 'reports/investigations/codefuse-functionality');

// Shapes that identify a builder's filesystem rather than the measurement.
const HOST_PATH_PATTERNS = [
  /\/mnt\/[A-Za-z0-9._-]+\//,
  /\/home\/[A-Za-z0-9._-]+\//,
  /\/Users\/[A-Za-z0-9._-]+\//,
  /\/root\//,
  /[A-Za-z]:\\Users\\/,
];

const FIRST_ERROR_MESSAGE_LIMIT = 400;

function collectArtifactFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'harness') continue;
      collectArtifactFiles(target, found);
    } else if (/\.(json|c)$/.test(entry.name)) {
      found.push(target);
    }
  }
  return found;
}

test('compiler diagnostics are reduced to platform-neutral paths', () => {
  const root = '/mnt/workspace/hex-ida';
  const absolute =
    `${root}/reports/investigations/codefuse-functionality/per-case/sources/case.c:21:15: `
    + "error: 'global_13FD8' undeclared (first use in this function)";

  const diagnostics = summarizeDiagnostics(`${absolute}\n`, { rootDir: root });

  assert.equal(diagnostics.errorCount, 1);
  assert.equal(diagnostics.firstError.line, 21);
  assert.equal(diagnostics.firstError.column, 15);
  assert.equal(diagnostics.firstErrorRaw.startsWith('reports/'), true, diagnostics.firstErrorRaw);
  assert.equal(diagnostics.firstErrorRaw.includes(root), false);
  for (const pattern of HOST_PATH_PATTERNS) {
    assert.doesNotMatch(diagnostics.firstErrorRaw, pattern);
  }

  // The helper is the single reduction point, so a caller that forgets rootDir
  // cannot smuggle the prefix back in through a different code path later.
  assert.equal(stripHostRoot(absolute, root).startsWith('reports/'), true);
  assert.equal(stripHostRoot(absolute, null), absolute);
});

test('a diagnostic line that fails to parse is still stripped of the host root', () => {
  const root = '/home/builder/hex';
  const unparseable = `${root}/reports/x.c: not a gcc diagnostic at all`;
  const diagnostics = summarizeDiagnostics(`${unparseable}\n`, { rootDir: root });
  assert.equal(diagnostics.errorCount, 0);
  assert.equal(diagnostics.firstErrorRaw, null);
});

test('committed lane artifacts carry no host-specific paths', () => {
  const files = collectArtifactFiles(LANE_DIR);
  assert.ok(files.length > 0, 'expected committed lane artifacts to exist');

  const offenders = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of HOST_PATH_PATTERNS) {
      const match = pattern.exec(text);
      if (match) offenders.push(`${path.relative(REPO_ROOT, file)} -> ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `host paths must not be committed:\n${offenders.join('\n')}`);
});

test('probe summary records explicit, clean provenance', () => {
  const summary = JSON.parse(fs.readFileSync(path.join(LANE_DIR, 'probe-summary.json'), 'utf8'));

  assert.match(summary.identity.headSha, /^[0-9a-f]{40}$/, 'headSha must be a commit SHA');
  assert.equal(
    Object.hasOwn(summary.identity, 'worktreeDirty'),
    true,
    'a recorded HEAD is meaningless without knowing whether the tree was clean',
  );
  assert.equal(typeof summary.identity.worktreeDirty, 'boolean');
  assert.equal(summary.identity.worktreeDirty, false, 'committed evidence must come from a clean worktree');
});

test('per-case records keep a bounded first failure instead of a full compiler log', () => {
  const caseFile = path.join(LANE_DIR, 'per-case/1_1_clang_O0_g.json');
  const record = JSON.parse(fs.readFileSync(caseFile, 'utf8'));
  const diagnostics = record.rawLane.preprocessed.diagnostics;

  assert.equal(record.rawLane.preprocessed.compileSucceeded, false);
  assert.ok(diagnostics.errorCount > 0);
  assert.ok(diagnostics.stderrBytes > 0, 'the size of the discarded log is still recorded');
  assert.ok(diagnostics.firstError.message.length <= FIRST_ERROR_MESSAGE_LIMIT);
  assert.equal(
    Object.hasOwn(diagnostics, 'stderr'),
    false,
    'the full compiler log must never be committed',
  );
});
