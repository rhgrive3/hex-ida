import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyPatchEquivalence } from '../../../js/symbolic/verify/patch.js';

const targets = { originalTarget: {}, patchedTarget: {} };

test('verifyPatchEquivalence rejects non-string and empty patch identities before proof execution', async () => {
  for (const invalid of [['bin-A'], { toString: () => 'bin-A' }, 1, true, '']) {
    await assert.rejects(
      verifyPatchEquivalence({
        ...targets,
        originalBinaryId: invalid,
        patchedPatchSetId: 'patch-1',
      }),
      /originalBinaryId must be a non-empty string/,
    );
  }

  for (const invalid of [['patch-1'], { toString: () => 'patch-1' }, 1, true, '']) {
    await assert.rejects(
      verifyPatchEquivalence({
        ...targets,
        originalBinaryId: 'bin-A',
        patchedPatchSetId: invalid,
      }),
      /patchedPatchSetId must be a non-empty string/,
    );
  }
});
