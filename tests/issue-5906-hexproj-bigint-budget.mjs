// Regression for #5906: the .hexproj BigInt reviver enforces a per-value
// magnitude budget BEFORE BigInt() conversion — a hostile scalar inside the
// 16 MiB file limit cannot pay unbounded conversion cost.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseHexProject, serializeHexProject } from '../js/project/index.js';

test('#5906 a legitimate machine-integer project still round-trips', () => {
  const project = {
    format: 'hexproj', version: 2,
    binary: { hash: 'x', metadata: { addr: 12345678901234567890n } },
    embedded: false,
  };
  const back = parseHexProject(serializeHexProject(project));
  assert.equal(back.binary.metadata.addr, 12345678901234567890n);
});

test('#5906 a single scalar with a huge hex magnitude is rejected as a resource limit', () => {
  const huge = 'f'.repeat(15_000_000);
  const text = JSON.stringify({
    format: 'hexproj', version: 2,
    binary: { hash: 'x', metadata: { attacker: { $hexBigInt: huge } } },
    embedded: false,
  });
  assert.ok(text.length < 16 * 1024 * 1024, 'the hostile file must stay inside the 16 MiB file limit');
  const start = Date.now();
  assert.throws(
    () => parseHexProject(text),
    (error) => error?.code === 'resource-limit' || /resource limit/.test(error?.message ?? ''),
  );
  // The budget is checked before the conversion: no multi-hundred-ms parse.
  assert.ok(Date.now() - start < 1000, 'rejection must happen before the BigInt conversion');
});

test('#5906 values within the budget keep converting', () => {
  const text = JSON.stringify({
    format: 'hexproj', version: 2,
    binary: { hash: 'x', metadata: { addr: { $hexBigInt: 'f'.repeat(16) } } },
    embedded: false,
  });
  const parsed = parseHexProject(text);
  assert.equal(parsed.binary.metadata.addr, (1n << 64n) - 1n);
});
