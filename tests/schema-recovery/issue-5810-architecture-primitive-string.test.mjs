import assert from 'node:assert/strict';
import test from 'node:test';

import { recoverSchemas } from '../../js/schema.js';

/* Schema recovery must honor the canonical architecture boundary: only real
 * primitive strings are architecture identity (mirroring
 * `canonicalArchitectureId()` in js/targets/architecture/registry.js). The
 * previous `String()` coercion promoted structured values —
 * `String(['arm64']) === 'arm64'` — into a supported-architecture admission
 * (#5810). */

const base = {
  strings: [],
  program: { unsupported: false },
  read: async () => new Uint8Array(),
};

test('structured architecture values fail closed to unsupported instead of coercing to arm64', async () => {
  for (const structured of [['arm64'], { toString: () => 'arm64' }]) {
    const result = await recoverSchemas({ ...base, architecture: structured });
    assert.equal(result.unsupported, true, `${JSON.stringify(String(structured))} must not become a supported architecture`);
    assert.equal(result.complete, false);
    assert.equal(result.incompleteReason, 'unsupported-architecture');
  }
});

test('program-architecture evidence is held to the same primitive-string rule', async () => {
  const result = await recoverSchemas({ ...base, program: { unsupported: false, architecture: ['aarch64'] } });
  assert.equal(result.unsupported, true);
  assert.equal(result.complete, false);
});

test('real primitive string architectures keep their support decision', async () => {
  const supported = await recoverSchemas({ ...base, architecture: 'arm64' });
  assert.equal(supported.unsupported, false);

  const supportedAlias = await recoverSchemas({ ...base, architecture: '  AARCH64  ' });
  assert.equal(supportedAlias.unsupported, false, 'canonical trim/lowercase normalization is preserved');

  const unsupportedArch = await recoverSchemas({ ...base, architecture: 'mips' });
  assert.equal(unsupportedArch.unsupported, true);

  const missing = await recoverSchemas({ ...base, program: { unsupported: false } });
  assert.equal(missing.unsupported, false, 'an absent architecture keeps the legacy non-unsupported default');
});

test('program.unsupported evidence still marks records unsupported', async () => {
  const result = await recoverSchemas({ ...base, architecture: 'arm64', program: { unsupported: true } });
  assert.equal(result.unsupported, true);
});
