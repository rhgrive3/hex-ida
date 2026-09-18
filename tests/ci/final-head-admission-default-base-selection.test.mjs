import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflowSource = fs.readFileSync(
  new URL('../../.github/workflows/final-head-admission.yml', import.meta.url),
  'utf8',
);

assert.match(
  workflowSource,
  /const defaultBranch = context\.payload\.repository\?\.default_branch \?\? null;/,
  'controller must resolve the repository default branch before PR selection',
);

assert.match(
  workflowSource,
  /candidate\.head\?\.sha === sha\s*&& candidate\.base\?\.ref === defaultBranch/,
  'status-event SHA lookup must ignore reverse/temp PRs that do not target the default branch',
);

assert.match(
  workflowSource,
  /if \(!defaultBranch \|\| pr\.base\?\.ref !== defaultBranch\)/,
  'explicit PR-number events must also refuse non-default-base PRs',
);

console.log('final-head admission default-base PR selection contract: PASS');
