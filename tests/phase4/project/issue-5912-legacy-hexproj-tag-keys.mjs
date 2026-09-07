/**
 * #5912 — legacy (pre-#1366) `.hexproj` documents carry literal
 * `$$hexBigInt`-style keys as ordinary user data with no escape provenance.
 * The reader must take its one-$ unescape only on documents written by an
 * escape-aware serializer — every such writer stamps `version >= 2` — and
 * must leave a v1 document's literal keys untouched.
 */
import assert from 'node:assert/strict';
import { parseHexProject, serializeHexProject, createHexProject } from '../../../js/project/index.js';

const legacyDoc = (customValue) => JSON.stringify({
  format:'hexproj',
  version:1,
  createdAt:'2026-08-22T00:00:00.000Z',
  updatedAt:'2026-08-22T00:00:00.000Z',
  binary:{
    hash:null,
    metadata:{ custom:customValue },
    embedded:false,
  },
  user:{},
  findings:{},
  analysis:{},
  navigation:{},
});

{
  const parsed = parseHexProject(legacyDoc({ '$$hexBigInt':'x' }));
  assert.deepEqual(parsed.binary.metadata.custom, { '$$hexBigInt':'x' },
    'a v1 literal $$hexBigInt key must not be unescaped (#5912)');
}
{
  const parsed = parseHexProject(legacyDoc({ '$$$hexBigInt':'x', '$$$$hexBigInt':'y' }));
  assert.deepEqual(parsed.binary.metadata.custom, { '$$$hexBigInt':'x', '$$$$hexBigInt':'y' });
}
{
  const parsed = parseHexProject(legacyDoc({ nested:{ '$$hexBigInt':'keep' }, plain:'v' }));
  assert.deepEqual(parsed.binary.metadata.custom.nested, { '$$hexBigInt':'keep' });
}

{
  // A v2 (escape-aware) document still unescapes exactly one level.
  const v2Doc = JSON.stringify({
    format:'hexproj',
    version:2,
    createdAt:'2026-08-30T00:00:00.000Z',
    updatedAt:'2026-08-30T00:00:00.000Z',
    binary:{ hash:null, metadata:{ custom:{ '$$hexBigInt':'escaped-from-$hexBigInt' } }, embedded:false },
    user:{}, findings:{}, analysis:{}, navigation:{},
  });
  const parsed = parseHexProject(v2Doc);
  assert.deepEqual(parsed.binary.metadata.custom, { '$hexBigInt':'escaped-from-$hexBigInt' },
    'a v2 document carries escape provenance: one $ is taken back');
}

{
  // Round-trip remains injective for current writers: a v2 document with a
  // literal $$hexBigInt user key serializes escaped and reads back verbatim.
  const roundTripped = parseHexProject(serializeHexProject(createHexProject({
    binaryMetadata:{ custom:{ $$hexBigInt:'literal-user-data' } },
  })));
  assert.deepEqual(roundTripped.binary.metadata.custom, { $$hexBigInt:'literal-user-data' });
}

console.log('issue-5912 legacy hexproj tag keys regression: PASS');
