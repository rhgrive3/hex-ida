import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAnalysisIdentity as current } from '../../../js/decompiler/phase8/analysis-identity.js';
import { canonicalAnalysisIdentity as original } from '../../helpers/analysis-identity-baseline-oracle.mjs';
import { fixture } from '../helpers/ir-fixtures.mjs';

function buildHeavySharedIr() {
  const f = fixture('heavy-sharing-ir');
  f.block(0);

  // Shared origin object on many values and instructions
  const sharedOrigin = {
    file: 'shared_source.c',
    line: 42,
    col: 10,
    range: { start: 100, end: 200 },
  };

  const sharedRange = { start: 0, end: 50 };
  const sharedMetadata = {
    tag: 'shared-meta',
    range: sharedRange,
    nested: { active: true, flags: [1, 2, 3] },
  };

  // Values with shared metadata, negative zero, bigint, unicode strings
  const a = f.constant(100n, 64);
  a.origin = sharedOrigin;
  a.metadata = sharedMetadata;

  const b = f.constant(200n, 64);
  b.origin = sharedOrigin;
  b.metadata = sharedMetadata;

  const c = f.binary('add', a, b, 64);
  c.origin = sharedOrigin;
  c.metadata = {
    negZero: -0,
    posZero: 0,
    big: 123456789012345678901234567890n,
    unicode: '🔥 Unicode 测试 🚀 \u0000\u001f\uffff',
    sharedChild: sharedMetadata,
  };

  // Map and Set metadata
  const mapMeta = new Map([
    ['b_key', { ref: sharedMetadata, count: 2 }],
    ['a_key', { ref: sharedMetadata, count: 1 }],
  ]);
  const setMeta = new Set(['entry2', 'entry1', sharedRange]);

  const sparseArr = [1];
  sparseArr[5] = 42;

  const d = f.binary('sub', c, b, 64);
  d.origin = sharedOrigin;
  d.metadata = {
    map: mapMeta,
    set: setMeta,
    sparse: sparseArr,
    nestedSharedAtDiffDepth: {
      level1: {
        level2: sharedMetadata,
      },
    },
  };

  f.ret(d);
  const ir = f.build();
  ir.origin = sharedOrigin;
  for (const block of ir.blocks) {
    block.origin = sharedOrigin;
    for (const instruction of block.insts) {
      instruction.origin = sharedOrigin;
      instruction.metadata = sharedMetadata;
    }
  }

  return ir;
}

test('canonicalAnalysisIdentity equivalence on heavy object sharing IR', () => {
  const ir = buildHeavySharedIr();
  const currentResult = current({ ir });
  const originalResult = original({ ir });

  assert.equal(currentResult.valid, true);
  assert.equal(originalResult.valid, true);
  assert.deepEqual(currentResult, originalResult);
});

test('canonicalAnalysisIdentity equivalence on cyclic metadata failing closed identically', () => {
  const ir = buildHeavySharedIr();
  const cycleObj = { tag: 'cycle' };
  cycleObj.self = cycleObj;
  ir.values[0].metadata = cycleObj;

  const currentResult = current({ ir });
  const originalResult = original({ ir });

  assert.equal(currentResult.valid, false);
  assert.equal(originalResult.valid, false);
  assert.deepEqual(currentResult, originalResult);
});

test('canonicalAnalysisIdentity equivalence across diverse shared structures and corner cases', () => {
  const testCases = [
    // Shared object appearing at different depths
    (() => {
      const f = fixture('depth-case');
      f.block(0);
      const leaf = { x: 1, y: 'str' };
      const v = f.constant(1n, 32);
      v.metadata = {
        shallow: leaf,
        deep: { a: { b: { c: leaf } } },
      };
      f.ret(v);
      return f.build();
    })(),
    // Diverse Map and Set sorting with shared objects
    (() => {
      const f = fixture('map-set-case');
      f.block(0);
      const sharedChild = { id: 99 };
      const v = f.constant(2n, 32);
      v.metadata = {
        m: new Map([
          [{ k: 2, s: sharedChild }, 'val2'],
          [{ k: 1, s: sharedChild }, 'val1'],
        ]),
        s: new Set([{ tag: 'b', c: sharedChild }, { tag: 'a', c: sharedChild }]),
      };
      f.ret(v);
      return f.build();
    })(),
    // Array with holes, non-index properties, and shared references
    (() => {
      const f = fixture('array-case');
      f.block(0);
      const shared = { marker: true };
      const arr = [shared];
      arr[3] = shared;
      arr.extraProp = shared;
      const v = f.constant(3n, 32);
      v.metadata = { arr };
      f.ret(v);
      return f.build();
    })(),
    // Date and special scalars
    (() => {
      const f = fixture('scalar-case');
      f.block(0);
      const v = f.constant(4n, 32);
      v.metadata = {
        date: new Date('2026-09-24T12:00:00.000Z'),
        negZero: -0,
        zero: 0,
        big: 0n,
        emptyStr: '',
        unicode: '日本語\uD83D\uDE00',
      };
      f.ret(v);
      return f.build();
    })(),
  ];

  for (const ir of testCases) {
    const cur = current({ ir });
    const orig = original({ ir });
    assert.deepEqual(cur, orig);
  }
});
