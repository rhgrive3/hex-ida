from pathlib import Path

repls = {
  'js/analysis/alias/regions-v2.js': [(
    "const categories = Array.isArray(node.unknown?.categories) ? node.unknown.categories.map(String) : [];",
    "const categories = Array.isArray(node.unknown?.categories) ? node.unknown.categories : [];"
  )],
  'js/analysis/alias/legacy-safety-floor.js': [(
    "function storageClass(region) {\n  const value = region?.metadata?.canonicalRootStorageClass;\n  return value == null ? null : String(value);\n}",
    "function storageClass(region) {\n  const value = region?.metadata?.canonicalRootStorageClass;\n  if (typeof value !== 'string') return null;\n  const text = value.trim();\n  return text || null;\n}"
  )],
  'js/analysis/alias/canonical-address-v2.js': [(
    "const kind = descriptor == null ? null : String(descriptor.kind ?? '');",
    "const kind = typeof descriptor?.kind === 'string' ? descriptor.kind.trim() : null;"
  )],
}

for name, pairs in repls.items():
    p = Path(name)
    s = p.read_text()
    for old, new in pairs:
        if old in s:
            s = s.replace(old, new, 1)
        elif new not in s:
            raise SystemExit(f'anchor drift: {name}: {old[:80]}')
    p.write_text(s)

Path('tests/phase7/issues-2924-2926-2928-alias-strict-boundaries.mjs').write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import { aliasMemoryRegions } from '../../js/analysis/alias/legacy-safety-floor.js';

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

assert.equal(aliasMemoryRegions(stack('function-local-stack'), external('external-entry-memory')), 'no');
assert.equal(aliasMemoryRegions(stack(['function-local-stack']), external(['external-entry-memory'])), 'may', 'non-string storage classes must not prove NoAlias');
assert.equal(aliasMemoryRegions(stack('function-local-stack'), global('image-global')), 'no');
assert.equal(aliasMemoryRegions(stack(['function-local-stack']), global(['image-global'])), 'may', 'non-string global classes must not prove NoAlias');

const regions = fs.readFileSync(new URL('../../js/analysis/alias/regions-v2.js', import.meta.url), 'utf8');
assert.doesNotMatch(regions, /unknown\.categories\.map\(String\)/, 'malformed unknown categories must not be coerced to flags');
assert.match(regions, /categories\.every\(\(category\) => category === 'flags'\)/, 'only exact flags strings may be projected out');

const canonical = fs.readFileSync(new URL('../../js/analysis/alias/canonical-address-v2.js', import.meta.url), 'utf8');
assert.match(canonical, /typeof descriptor\?\.kind === 'string'/, 'separation descriptor kind must be string-only');
assert.doesNotMatch(canonical, /String\(descriptor\.kind/, 'descriptor kind must not be coerced');

console.log('issues-2924-2926-2928-alias-strict-boundaries: PASS');
''')
