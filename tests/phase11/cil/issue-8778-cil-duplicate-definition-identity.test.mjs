import assert from 'node:assert/strict';
import { buildCil } from '../fixtures/medium-cil.mjs';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { readCilMetadataContext } from '../../../js/managed/cil/metadata-context.js';

console.log('[phase11] running issue #8778 CIL duplicate-definition identity tests...');

// `parseCil` collapses internal metadata codes to `cil-unsupported-binary`, so the
// fail-closed identity authority is observed on the validated metadata context that
// the public pipeline itself builds.
const rawParse = (bytes, options = {}) => readCilMetadataContext(bytes, options);

const typeRow = (name, namespace = 'N') => ({ name, namespace, flags: 1, fieldList: 1, methodList: 1 });
const parse = (options) => rawParse(buildCil({
  imageSize: 0x6000, metadataSize: 0x5000, ...options,
}).bytes, {});

// ECMA-335 II.22.24: two TypeDefs with one (Namespace, Name) identity split one
// CLI definition across two tokens, so the parse must fail closed.
assert.throws(() => parse({
  methods: [], types: [typeRow('Dup'), typeRow('Dup')],
}), /cil-typedef-identity-duplicate/);

// Distinct top-level TypeDef identities stay valid through the public frontend.
{
  const bytes = buildCil({
    methods: [], types: [typeRow('Alpha'), typeRow('Beta')],
    imageSize: 0x6000, metadataSize: 0x5000,
  }).bytes;
  assert.ok(parseCil(bytes, { binaryId: 'distinct-typedef' }).types.length === 2);
  assert.equal(rawParse(bytes, {}).defs.types.length, 2);
}

// Two TypeDefs with the same name but different namespaces are distinct identities.
assert.equal(parse({
  methods: [], types: [typeRow('Same', 'A'), typeRow('Same', 'B')],
}).defs.types.length, 2);

// Field identity is (owner, name, signature) for every non-CompilerControlled row.
assert.throws(() => parse({
  methods: [], types: [{ name: 'T', namespace: 'N', fieldList: 1, methodList: 1 }],
  fields: [{ name: 'dup' }, { name: 'dup' }],
}), /cil-field-identity-duplicate/);

// Distinct field names under one owner stay valid.
assert.equal(parse({
  methods: [], types: [{ name: 'T', namespace: 'N', fieldList: 1, methodList: 1 }],
  fields: [{ name: 'a', signature: [0x06, 0x08] }, { name: 'b', signature: [0x06, 0x08] }],
}).defs.fields.length, 2);

// Same field name with a different signature blob is a distinct identity.
assert.equal(parse({
  methods: [], types: [{ name: 'T', namespace: 'N', fieldList: 1, methodList: 1 }],
  fields: [{ name: 'over', signature: [0x06, 0x08] }, { name: 'over', signature: [0x06, 0x0e] }],
}).defs.fields.length, 2);

// CompilerControlled fields are excluded from the duplicate rule (II.22.24).
assert.equal(parse({
  methods: [], types: [{ name: 'T', namespace: 'N', fieldList: 1, methodList: 1 }],
  fields: [{ name: 'cc', flags: 0 }, { name: 'cc', flags: 0 }],
}).defs.fields.length, 2);

// MethodDef identity is (owner, name, signature) except CompilerControlled.
// Public|HideBySig (0x0086) and Private (0x0001) are ordinary access values.
for (const flags of [0x0086, 0x0001]) {
  assert.throws(() => parse({
    types: [{ name: 'T', namespace: 'N', fieldList: 1, methodList: 1 }],
    methods: [
      { name: 'DupMethod', flags, signature: [0x00, 0x00, 0x01], body: [0x2a] },
      { name: 'DupMethod', flags, signature: [0x00, 0x00, 0x01], body: [0x2a] },
    ],
  }), /cil-methoddef-identity-duplicate/, `method flags 0x${flags.toString(16)}`);
}

// Ordinary overloads — same name, different signature — stay valid.
assert.equal(parse({
  types: [{ name: 'T', namespace: 'N', fieldList: 1, methodList: 1 }],
  methods: [
    { name: 'Over', flags: 0x0086, signature: [0x00, 0x00, 0x01], body: [0x2a] },
    { name: 'Over', flags: 0x0086, signature: [0x00, 0x01, 0x08], body: [0x2a] },
  ],
}).defs.methods.length, 2);

// The same method name under different owning types is not a duplicate identity.
assert.equal(parse({
  types: [
    { name: 'A', namespace: 'N', fieldList: 1, methodList: 1 },
    { name: 'B', namespace: 'N', fieldList: 1, methodList: 2 },
  ],
  methods: [
    { name: 'Run', flags: 0x0086, signature: [0x00, 0x00, 0x01], body: [0x2a] },
    { name: 'Run', flags: 0x0086, signature: [0x00, 0x00, 0x01], body: [0x2a] },
  ],
}).defs.methods.length, 2);

// CompilerControlled methods (MethodAccess == 0) are excluded (II.22.26).
assert.equal(parse({
  types: [{ name: 'T', namespace: 'N', fieldList: 1, methodList: 1 }],
  methods: [
    { name: 'cc', flags: 0x0000, signature: [0x00, 0x00, 0x01], body: [0x2a] },
    { name: 'cc', flags: 0x0000, signature: [0x00, 0x00, 0x01], body: [0x2a] },
  ],
}).defs.methods.length, 2);

// The shared default fixture still parses.
assert.ok(rawParse(buildCil({}).bytes, {}).defs.types.length >= 1);

console.log('ok #8778 CIL duplicate-definition identity fails closed');
