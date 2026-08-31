from pathlib import Path

ROOT = Path('.')

def read(path):
    return (ROOT / path).read_text()

def write(path, text):
    (ROOT / path).write_text(text)

def replace_once(path, old, new):
    text = read(path)
    if old not in text:
        raise SystemExit(f'anchor not found: {path}: {old[:120]!r}')
    write(path, text.replace(old, new, 1))

# #3020: only explicit primitive integer representations may become proof-bearing offsets.
replace_once(
    'js/analysis/pointsto/lattice.js',
    """function big(value) {\n  if (value == null) return null;\n  try { return typeof value === 'bigint' ? value : BigInt(value); }\n  catch { return null; }\n}\n""",
    """function big(value) {\n  if (value == null) return null;\n  if (typeof value === 'bigint') return value;\n  if (typeof value === 'number') {\n    if (!Number.isSafeInteger(value)) return null;\n    return BigInt(value);\n  }\n  if (typeof value !== 'string') return null;\n  const text = value.trim();\n  if (!text) return null;\n  try { return BigInt(text); }\n  catch { return null; }\n}\n""",
)

# #3018: separation proof metadata is authority-bearing and must not be String()-laundered.
replace_once(
    'js/analysis/pointsto/lattice.js',
    """    separationClass: input.separationClass == null ? null : String(input.separationClass),\n    separationAuthority: input.separationAuthority == null ? null : String(input.separationAuthority),\n""",
    """    separationClass: typeof input.separationClass === 'string' ? input.separationClass : null,\n    separationAuthority: typeof input.separationAuthority === 'string' ? input.separationAuthority : null,\n""",
)

Path('tests/phase7/pointsto/strict-boundaries.test.mjs').parent.mkdir(parents=True, exist_ok=True)
Path('tests/phase7/pointsto/strict-boundaries.test.mjs').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UNBOUNDED_RANGE,
  createOffsetRange,
  createPointsToSet,
  createPointsToTarget,
  exactRange,
} from '../../../js/analysis/pointsto/lattice.js';
import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';

const complete = Object.freeze({ completeness: 'complete' });

function singleton(target) {
  return createPointsToSet({ targets: [target] });
}

test('#3020 structured offset values fail closed instead of minting exact ranges', () => {
  for (const malformed of [
    ['8'],
    [8],
    true,
    false,
    { toString() { return '8'; } },
    { valueOf() { return 8; } },
    1.5,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.deepEqual(exactRange(malformed), UNBOUNDED_RANGE);
  }

  assert.deepEqual(exactRange(8n), createOffsetRange(8n, 8n));
  assert.deepEqual(exactRange(8), createOffsetRange(8n, 8n));
  assert.deepEqual(exactRange('8'), createOffsetRange(8n, 8n));
  assert.deepEqual(exactRange('0x8'), createOffsetRange(8n, 8n));
});

test('#3020 malformed offsets cannot manufacture strong same-root alias answers', () => {
  const root = {
    addressSpace: 'memory',
    rootKind: 'rooted',
    rootEntityId: 'root-A',
    widthBits: 64,
  };
  const left = singleton(createPointsToTarget({ ...root, offsetRange: exactRange(['0']) }));
  const right = singleton(createPointsToTarget({ ...root, offsetRange: exactRange(['8']) }));
  const result = pointsToAlias(left, right, {
    status: complete,
    widthBitsLeft: 64,
    widthBitsRight: 64,
  });
  assert.equal(result.relation, 'may');
});

test('#3018 non-string separation metadata cannot produce descriptor-backed NoAlias', () => {
  const malformedA = createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'rooted',
    rootEntityId: 'A',
    separationClass: ['global-like'],
    separationAuthority: ['root-descriptor'],
    offsetRange: exactRange(0),
  });
  const malformedB = createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'rooted',
    rootEntityId: 'B',
    separationClass: ['global-like'],
    separationAuthority: ['root-descriptor'],
    offsetRange: exactRange(0),
  });
  assert.equal(malformedA.separationClass, null);
  assert.equal(malformedA.separationAuthority, null);
  assert.equal(pointsToAlias(singleton(malformedA), singleton(malformedB), {
    status: complete,
    widthBitsLeft: 64,
    widthBitsRight: 64,
  }).relation, 'may');

  const validA = createPointsToTarget({
    addressSpace: 'memory', rootKind: 'rooted', rootEntityId: 'A',
    separationClass: 'global-like', separationAuthority: 'root-descriptor',
    offsetRange: exactRange(0),
  });
  const validB = createPointsToTarget({
    addressSpace: 'memory', rootKind: 'rooted', rootEntityId: 'B',
    separationClass: 'global-like', separationAuthority: 'root-descriptor',
    offsetRange: exactRange(0),
  });
  assert.equal(pointsToAlias(singleton(validA), singleton(validB), {
    status: complete,
    widthBitsLeft: 64,
    widthBitsRight: 64,
  }).relation, 'no');
});
''')
