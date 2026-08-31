from pathlib import Path

def replace(path, old, new):
    p = Path(path); s = p.read_text()
    if old in s:
        p.write_text(s.replace(old, new, 1)); return
    if new in s: return
    raise SystemExit(f'anchor drift: {path}: {old[:80]}')

replace('js/analysis/alias/regions-v2.js',
        "const categories = Array.isArray(node.unknown?.categories) ? node.unknown.categories.map(String) : [];",
        "const categories = Array.isArray(node.unknown?.categories) ? node.unknown.categories : [];")

replace('js/analysis/alias/legacy-safety-floor.js',
        "function storageClass(region) {\n  const value = region?.metadata?.canonicalRootStorageClass;\n  return value == null ? null : String(value);\n}",
        "function storageClass(region) {\n  const value = region?.metadata?.canonicalRootStorageClass;\n  if (typeof value !== 'string') return null;\n  const text = value.trim();\n  return text || null;\n}")

replace('js/analysis/alias/canonical-address-v2.js',
        "const kind = descriptor == null ? null : String(descriptor.kind ?? '');",
        "const kind = typeof descriptor?.kind === 'string' ? descriptor.kind.trim() : null;")

replace('js/analysis/alias/canonical-address-v2-core.js',
        "const operator = String(node.operator ?? '').toLowerCase();",
        "const operator = typeof node.operator === 'string' ? node.operator.toLowerCase() : '';" )
replace('js/analysis/alias/canonical-address-v2-core.js',
        "if (rhsNode?.kind !== 'unary' || String(rhsNode.operator ?? '').toLowerCase() !== 'not' || rhsNode.inputs?.length !== 1) {",
        "if (rhsNode?.kind !== 'unary' || typeof rhsNode.operator !== 'string' || rhsNode.operator.toLowerCase() !== 'not' || rhsNode.inputs?.length !== 1) {")
replace('js/analysis/alias/canonical-address-v2-core.js',
        "if ((node.kind === 'intrinsic' || node.kind === 'binary') && String(node.operator ?? '').toLowerCase() === 'add-with-carry') {",
        "if ((node.kind === 'intrinsic' || node.kind === 'binary') && typeof node.operator === 'string' && node.operator.toLowerCase() === 'add-with-carry') {")

out = Path('tests/phase7/alias/strict-authority-boundaries-2924-2965.test.mjs')
out.write_text(r'''import test from 'node:test';
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
''')