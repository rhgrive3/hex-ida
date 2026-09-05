import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  discoverPhaseTests,
  runPhaseNodeTests,
} from '../support/phase-node-test-runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function discoverFinalClosureTests(root = HERE) {
  const discovered = discoverPhaseTests(root)
    .map((absolutePath) => path.relative(root, absolutePath).split(path.sep).join('/'));
  if (!discovered.includes('preflight.test.mjs')) {
    throw new Error('final-closure: required preflight.test.mjs is not discoverable');
  }
  if (new Set(discovered).size !== discovered.length) {
    throw new Error('final-closure: discovered test list contains duplicates');
  }
  const sorted = [...discovered].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (!discovered.every((relativePath, index) => relativePath === sorted[index])) {
    throw new Error('final-closure: discovered test list is not bytewise sorted');
  }
  return discovered;
}

export function ownedFinalClosureTestSubtrees(ownership) {
  const subtrees = [];
  for (const row of Object.values(ownership?.tasks || {})) {
    for (const pattern of row?.allowedPaths || []) {
      if (/^tests\/final-closure\/[^/*]+\/\*\*$/.test(pattern)) {
        subtrees.push(pattern.slice(0, -3));
      }
    }
  }
  return [...new Set(subtrees)].sort();
}

export function runFinalClosureTests(argv = process.argv.slice(2), { root = HERE } = {}) {
  discoverFinalClosureTests(root);
  return runPhaseNodeTests({
    phase: 'final-closure',
    root,
    argv,
    cwd: path.resolve(root, '../..'),
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runFinalClosureTests();
