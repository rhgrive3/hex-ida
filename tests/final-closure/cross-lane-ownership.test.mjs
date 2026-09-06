import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  githubEvent as phase11GithubEvent,
  parsePhase11NameStatus,
  phase11InventoryFromGit,
  phase11CrossLaneIntegration,
  phase11OwnershipViolation,
} from '../../tools/validation/phase11/ownership-check.mjs';
import {
  githubEvent as phase12GithubEvent,
  inventoryFromGit as phase12InventoryFromGit,
  parsePhase12NameStatus,
  phase12CrossLaneIntegration,
  shouldSkipPhase12Ownership,
  validateAggregateFiles,
  validateFiles,
  loadManifest,
  runOwnership,
} from '../../tools/validation/phase12/ownership.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CROSS_LANE_REPOSITORY = 'fixture/final-closure';

const crossLaneEvent = {
  repository: { full_name: CROSS_LANE_REPOSITORY },
  pull_request: {
    head: { ref: 'recovery/final-closure-test', repo: { full_name: CROSS_LANE_REPOSITORY } },
    base: { ref: 'main', repo: { full_name: CROSS_LANE_REPOSITORY } },
    labels: [{ name: 'cross-lane-integration' }],
  },
};
const missingRepositoryEvent = {
  pull_request: crossLaneEvent.pull_request,
};
const missingHeadRepositoryEvent = {
  ...crossLaneEvent,
  pull_request: {
    ...crossLaneEvent.pull_request,
    head: { ref: crossLaneEvent.pull_request.head.ref },
  },
};
const missingBaseRepositoryEvent = {
  ...crossLaneEvent,
  pull_request: {
    ...crossLaneEvent.pull_request,
    base: { ref: crossLaneEvent.pull_request.base.ref },
  },
};
const forkHeadEvent = {
  ...crossLaneEvent,
  pull_request: {
    ...crossLaneEvent.pull_request,
    head: { ...crossLaneEvent.pull_request.head, repo: { full_name: 'fork/final-closure' } },
  },
};
const forkBaseEvent = {
  ...crossLaneEvent,
  pull_request: {
    ...crossLaneEvent.pull_request,
    base: { ...crossLaneEvent.pull_request.base, repo: { full_name: 'fork/final-closure' } },
  },
};
const mismatchedRepositoryEvent = {
  ...crossLaneEvent,
  repository: { full_name: 'other/final-closure' },
};
const missingLabelEvent = { pull_request: {} };
const wrongLabelEvent = { pull_request: { labels: [{ name: 'integration' }] } };
const malformedLabelEvent = { pull_request: { labels: 'cross-lane-integration' } };
const labelOnlyEvent = { pull_request: { labels: [{ name: 'cross-lane-integration' }] } };
const unrelatedBranchEvent = {
  pull_request: {
    head: { ref: 'feature/unrelated' },
    base: { ref: 'main' },
    labels: [{ name: 'cross-lane-integration' }],
  },
};
const componentBranchEvent = {
  pull_request: {
    head: { ref: 'component/final-closure-t051-test' },
    base: { ref: 'recovery/final-closure-test' },
    labels: [{ name: 'cross-lane-integration' }],
  },
};
const wrongBaseEvent = {
  pull_request: {
    head: { ref: 'analysis/final-closure-test' },
    base: { ref: 'release/test' },
    labels: [{ name: 'cross-lane-integration' }],
  },
};

for (const predicate of [phase11CrossLaneIntegration, phase12CrossLaneIntegration]) {
  assert.equal(predicate(crossLaneEvent), true, 'the exact cross-lane label must opt in');
  const removedLabel = {
    ...crossLaneEvent,
    pull_request: { ...crossLaneEvent.pull_request, labels: [] },
  };
  assert.equal(predicate(removedLabel), false, 'label removal must revoke a previously authorized repository and branch');
  assert.equal(predicate({ ...removedLabel, pull_request: {
    ...removedLabel.pull_request, labels: [{ name: 'cross-lane-integration' }],
  } }), true, 'label addition must authorize the next event for the same repository and branch');
  for (const [description, event] of [
    ['missing event repository must not opt in', missingRepositoryEvent],
    ['missing head repository must not opt in', missingHeadRepositoryEvent],
    ['missing base repository must not opt in', missingBaseRepositoryEvent],
    ['fork head repository must not opt in', forkHeadEvent],
    ['fork base repository must not opt in', forkBaseEvent],
    ['mismatched event repository must not opt in', mismatchedRepositoryEvent],
  ]) {
    assert.equal(predicate(event), false, description);
  }
  assert.equal(predicate(missingLabelEvent), false, 'a missing label must not opt in');
  assert.equal(predicate(wrongLabelEvent), false, 'a different label must not opt in');
  assert.equal(predicate(malformedLabelEvent), false, 'malformed labels must fail closed');
  assert.equal(predicate(labelOnlyEvent), false, 'a label without an authorized branch relationship must fail closed');
  assert.equal(predicate(unrelatedBranchEvent), false, 'an unrelated PR must not bypass ownership by label');
  assert.equal(predicate(componentBranchEvent), false, 'a component PR must retain its component ownership boundary');
  assert.equal(predicate(wrongBaseEvent), false, 'a final-closure head targeting a non-main base must fail closed');
  assert.equal(predicate(null), false, 'a missing event must fail closed');
}

for (const [phase, workflow] of [
  ['Phase 11', fs.readFileSync(path.join(ROOT, '.github/workflows/phase11-release-validation.yml'), 'utf8')],
  ['Phase 12', fs.readFileSync(path.join(ROOT, '.github/workflows/phase12-release-validation.yml'), 'utf8')],
]) {
  // Development mode intentionally removes automatic release-workflow PR
  // runs. The exact cross-lane predicate remains covered above; release
  // validation is entered through its explicit SHA dispatch path.
  assert.doesNotMatch(workflow, /^  pull_request:/m, `${phase} release validation must be dispatch-only`);
  assert.match(workflow, /^  workflow_dispatch:/m, `${phase} must retain exact-SHA dispatch`);
  assert.match(workflow, /cancel-in-progress:\s*true/, `${phase} must cancel stale dispatch runs`);
}

const validNameStatus = Buffer.from('M\0owned/file.js\0R100\0old/name.js\0new/name.js\0');
for (const parseNameStatus of [parsePhase11NameStatus, parsePhase12NameStatus]) {
  assert.deepEqual(
    parseNameStatus(validNameStatus),
    ['new/name.js', 'old/name.js', 'owned/file.js'],
    'NUL-delimited status records must retain both rename paths',
  );
  assert.throws(
    () => parseNameStatus(Buffer.from('M\0forbidden/evil\n.js\0')),
    /path is not canonical/,
    'control-byte paths must fail closed instead of passing through Git quoting',
  );
  assert.throws(
    () => parseNameStatus(Buffer.from('M\0owned\\forged.js\0')),
    /path is not canonical/,
    'backslash paths must not normalize into an owned path',
  );
  assert.throws(
    () => parseNameStatus(Buffer.from([0x4d, 0x00, 0xc3, 0x28, 0x00])),
    /path is not UTF-8/,
    'invalid UTF-8 paths must fail closed',
  );
  assert.throws(
    () => parseNameStatus(Buffer.from('M\0unfinished.js')),
    /not NUL terminated/,
    'unterminated Git output must fail closed',
  );
  assert.throws(
    () => parseNameStatus(Buffer.from('R100\0old.js\0')),
    /incomplete git diff record/,
    'truncated rename records must fail closed',
  );
}

const hostileRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'final-closure-ownership-path-'));
const hostileGit = (args) => {
  const result = spawnSync('git', args, { cwd: hostileRepo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
};
try {
  hostileGit(['init', '--quiet']);
  hostileGit(['config', 'user.name', 'Final Closure Test']);
  hostileGit(['config', 'user.email', 'final-closure@example.invalid']);
  fs.writeFileSync(path.join(hostileRepo, 'base.txt'), 'base\n');
  hostileGit(['add', 'base.txt']);
  hostileGit(['commit', '--quiet', '-m', 'base']);
  const baseSha = hostileGit(['rev-parse', 'HEAD']);
  fs.mkdirSync(path.join(hostileRepo, 'forbidden'));
  fs.writeFileSync(path.join(hostileRepo, 'forbidden', 'evil\n.js'), 'hostile\n');
  hostileGit(['add', '--all']);
  hostileGit(['commit', '--quiet', '-m', 'hostile path']);
  const headSha = hostileGit(['rev-parse', 'HEAD']);
  assert.throws(
    () => phase11InventoryFromGit(baseSha, headSha, hostileRepo),
    /path is not canonical/,
  );
  assert.throws(
    () => phase12InventoryFromGit(baseSha, headSha, hostileRepo),
    /path is not canonical/,
  );
} finally {
  fs.rmSync(hostileRepo, { recursive: true, force: true });
}

for (const readEvent of [phase11GithubEvent, phase12GithubEvent]) {
  assert.deepEqual(
    readEvent({ env: { GITHUB_EVENT_PATH: 'injected-event.json' }, readFile: () => JSON.stringify(crossLaneEvent) }),
    crossLaneEvent,
    'event parsing must accept an injected event reader',
  );
  assert.equal(
    readEvent({ env: { GITHUB_EVENT_PATH: 'injected-event.json' }, readFile: () => '{malformed' }),
    null,
    'malformed event JSON must fail closed',
  );
  assert.equal(readEvent({ env: {} }), null, 'a missing event path must fail closed');
}

const phase11Manifest = {
  allowedExact: ['owned.js'],
  allowedPrefixes: ['owned/'],
  forbiddenPrefixes: ['forbidden/'],
};
assert.equal(phase11OwnershipViolation('campaign/spec.md', phase11Manifest), 'unowned:campaign/spec.md');
assert.equal(
  phase11OwnershipViolation('campaign/spec.md', phase11Manifest, {
    allowUnowned: phase11CrossLaneIntegration(crossLaneEvent),
  }),
  null,
  'the exact cross-lane label may admit an unowned Phase 11 path',
);
assert.equal(
  phase11OwnershipViolation('forbidden/escape.js', phase11Manifest, { allowUnowned: true }),
  'forbidden:forbidden/escape.js',
  'the cross-lane opt-in must not bypass forbidden Phase 11 paths',
);

const phase12Manifest = loadManifest();
const allowUnowned = phase12CrossLaneIntegration(crossLaneEvent);
const laneWithoutOptIn = validateFiles(['campaign/spec.md'], 'p12-integration', phase12Manifest);
assert.equal(laneWithoutOptIn.ok, false);
assert.ok(laneWithoutOptIn.violations.some((item) => item.category === 'unowned'));
const laneWithOptIn = validateFiles(['campaign/spec.md'], 'p12-integration', phase12Manifest, { allowUnowned });
assert.equal(laneWithOptIn.ok, true, 'the exact cross-lane label may admit an unowned Phase 12 lane path');
const forbiddenLane = validateFiles(['js/binary/escape.js'], 'p12-integration', phase12Manifest, { allowUnowned });
assert.ok(forbiddenLane.violations.some((item) => item.category === 'forbidden'));
const generatedLane = validateFiles(['reports/phase12/phase12-release-evidence.json'], 'p12-k', phase12Manifest, { allowUnowned });
assert.ok(generatedLane.violations.some((item) => item.category === 'generated'));
const releaseOnlyManifest = { ...phase12Manifest, generatedPaths: [] };
const releaseLane = validateFiles(['reports/phase12/phase12-release-evidence.json'], 'p12-k', releaseOnlyManifest, { allowUnowned });
assert.ok(releaseLane.violations.some((item) => item.category === 'release'));

const aggregateWithoutOptIn = validateAggregateFiles(['campaign/spec.md'], phase12Manifest);
assert.equal(aggregateWithoutOptIn.ok, false);
assert.ok(aggregateWithoutOptIn.violations.some((item) => item.category === 'unowned'));
const aggregateWithOptIn = validateAggregateFiles(['campaign/spec.md'], phase12Manifest, { allowUnowned });
assert.equal(aggregateWithOptIn.ok, true, 'the exact cross-lane label may admit an unowned aggregate path');
assert.throws(
  () => runOwnership({
    baseSha: '1'.repeat(40),
    headSha: '2'.repeat(40),
    lane: 'p12-integration',
    manifest: phase12Manifest,
    event: crossLaneEvent,
    inventoryProvider: () => ['campaign/spec.md'],
  }),
  /unowned:campaign\/spec\.md/,
  'a component/lane ownership run must not inherit the aggregate cross-lane exception',
);
const forbiddenAggregate = validateAggregateFiles(['js/architecture/escape.js'], phase12Manifest, { allowUnowned });
assert.ok(forbiddenAggregate.violations.some((item) => item.category === 'forbidden'));

assert.equal(
  shouldSkipPhase12Ownership({ eventName: 'pull_request', headRef: 'dev-agent-hardening/example' }),
  true,
  'Dev Agent ownership skip must remain unchanged',
);

console.log('cross-lane Phase 11/12 ownership contract: PASS');
