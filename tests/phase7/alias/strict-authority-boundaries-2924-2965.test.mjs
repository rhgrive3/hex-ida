import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { aliasMemoryRegions } from '../../../js/analysis/alias/legacy-safety-floor.js';

const preciseOrigin = (id) => ({ instructionIds:[id] });
const stack = (storageClass) => ({
  kind:'stack-fixed', functionId:'f', offset:'0', widthBits:8,
  origin:preciseOrigin('stack'), metadata:{ canonicalRootStorageClass:storageClass },
});
const external = (storageClass) => ({
  kind:'rooted-offset', functionId:'f', rootEntityId:'arg0', offset:'0', widthBits:8,
  origin:preciseOrigin('external'), metadata:{ canonicalRootStorageClass:storageClass },
});
const global = (storageClass) => ({
  kind:'global-absolute', binaryId:'bin', address:'4096', widthBits:8,
  origin:preciseOrigin('global'), metadata:{ canonicalRootStorageClass:storageClass },
});

test('#2926 storage-class separation authority is string-only', () => {
  assert.equal(aliasMemoryRegions(stack('function-local-stack'), external('external-entry-memory')), 'no');
  assert.equal(aliasMemoryRegions(stack(['function-local-stack']), external(['external-entry-memory'])), 'may');
  assert.equal(aliasMemoryRegions(stack('function-local-stack'), global('image-global')), 'no');
  assert.equal(aliasMemoryRegions(stack(['function-local-stack']), global(['image-global'])), 'may');
});

test('#2924 unknown-state categories are not String-coerced into flags', () => {
  const source = fs.readFileSync(new URL('../../../js/analysis/alias/regions-v2.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /unknown\.categories\.map\(String\)/);
  assert.match(source, /categories\.every\(\(category\) => category === 'flags'\)/);
});

test('#2928 separation descriptor kind is string-only', () => {
  const source = fs.readFileSync(new URL('../../../js/analysis/alias/canonical-address-v2.js', import.meta.url), 'utf8');
  assert.match(source, /typeof descriptor\?\.kind === 'string'/);
  assert.doesNotMatch(source, /String\(descriptor\.kind/);
});

test('#2965 canonical arithmetic operators are string-only before case folding', () => {
  const source = fs.readFileSync(new URL('../../../js/analysis/alias/canonical-address-v2-core.js', import.meta.url), 'utf8');
  assert.match(source, /typeof node\.operator === 'string' \? node\.operator\.toLowerCase\(\) : ''/);
  assert.match(source, /typeof rhsNode\.operator !== 'string'/);
  assert.match(source, /typeof node\.operator === 'string' && node\.operator\.toLowerCase\(\) === 'add-with-carry'/);
  assert.doesNotMatch(source, /String\((?:rhsNode\.|node\.)operator/);
});
