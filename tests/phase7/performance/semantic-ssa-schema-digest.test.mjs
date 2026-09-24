import assert from 'node:assert/strict';
import test from 'node:test';

import { stableDigest } from '../../../js/core/identity/index.js';
import {
  buildSemanticSsa,
  canonicalSemanticSsaProducerBinding,
} from '../../../js/semantics/ssa/index.js';
import { fixture } from '../helpers/fixtures.mjs';

test('schema-streamed canonical SSA digest stays byte-identical to stableDigest', () => {
  const f = fixture('function_phase7_schema_digest');
  f.block('entry');
  let value = f.entryValue('arg0');
  for (let index = 0; index < 96; index += 1) {
    const constant = f.constant(`c${index}`, index + 1);
    value = f.binary(`v${index}`, index % 2 === 0 ? 'add' : 'xor', value, constant);
  }
  f.stateWrite('write0', 'x0', value);
  f.ret('ret0');

  const ir = f.ir();
  const cfg = f.cfg();
  const ssa = buildSemanticSsa(ir, cfg);
  const binding = canonicalSemanticSsaProducerBinding(ssa);

  assert.ok(binding);
  assert.ok(ssa.definitions.length > 90);
  assert.ok(ssa.uses.length > 90);
  assert.equal(binding.scalarSsaDigest, stableDigest(ssa));
});
