import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../../../tools/validation/phase5-ownership.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RETIRED_PHASE2_WORKFLOW = path.join(ROOT, '.github/workflows/phase2-effects-integration.yml');
const GENERATED_SYNC = fs.readFileSync(path.join(ROOT, '.github/workflows/generated-sync.yml'), 'utf8');
const MANIFEST = loadManifest();

test('generated userscript ownership survives retirement of Phase 2/5 campaign wrappers', () => {
  assert.deepEqual(MANIFEST.generatedWriteOwners, ['p5-0', 'p5-i']);
  assert.equal(fs.existsSync(RETIRED_PHASE2_WORKFLOW), false);
  assert.match(GENERATED_SYNC, /npm run userscript:build/);
  assert.match(GENERATED_SYNC, /git diff --exit-code --/);
  assert.match(GENERATED_SYNC, /userscript\/hex\.user\.template\.js/);
  assert.match(GENERATED_SYNC, /userscript\/release-version\.json/);
  assert.deepEqual(
    GENERATED_SYNC.split('\n')
      .filter((line) => line.includes('deployment-identity.generated.js'))
      .map((line) => line.trim()),
    ['run: git restore --source=HEAD --worktree -- js/userscript/deployment-identity.generated.js'],
    'Cloudflare-owned identity may only be restored from HEAD, never included in userscript output checks or writes',
  );
});
