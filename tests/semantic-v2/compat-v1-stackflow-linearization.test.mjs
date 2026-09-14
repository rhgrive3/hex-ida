import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(
  path.join(root, 'js/semantics/compat/semantic-ir-v2-to-v1-finalize.js'),
  'utf8',
);

// Structural stack-flow recovery was removed from the v2 projection. A
// reaching store is not a value proof, so this file must never grow another
// private dependency walk. Exact state reads are accepted only through the
// canonical MemorySSA proof shared by all consumers.
assert.match(source, /function recoverLocalStackFlow\(projected\)/);
assert.match(source, /isCanonicalExactMemoryForwarding/);
assert.doesNotMatch(source, /function stackDependentValueIds\(/);
assert.doesNotMatch(source, /dependentsByValueId/);
assert.doesNotMatch(source, /stackDependent\.has\(/);
assert.doesNotMatch(source, /function valueDependsOnRoots\(/);

console.log('semantic-v2 stack escape traversal linearization: PASS');
