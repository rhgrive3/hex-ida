import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compilePattern, evaluatePattern, typeCheckPattern } from '../js/pattern/index.js';
import { createAgentTools } from '../js/agent/tools.js';
import { buildSemanticModel } from '../js/blocks.js';
import { irFor } from '../js/ir.js';
import { createArtifactDescriptor } from '../js/core/artifacts/contracts.js';
import { descriptor, scheduler } from './phase4/scheduler/helpers.mjs';

describe('Wave 2 Area J regressions', () => {
  it('P1-1: preserves exact BigInt for i64 values below Number.MIN_SAFE_INTEGER', () => {
    const compiled = compilePattern('struct Signed64 { belowMin: i64le; atMin: i64le; int64Min: i64le; }');
    const buf = new ArrayBuffer(24);
    const view = new DataView(buf);
    const belowMin = BigInt(Number.MIN_SAFE_INTEGER) - 1n; // -9007199254740992n
    const atMin = BigInt(Number.MIN_SAFE_INTEGER);         // -9007199254740991n
    const int64Min = -9223372036854775808n;
    view.setBigInt64(0, belowMin, true);
    view.setBigInt64(8, atMin, true);
    view.setBigInt64(16, int64Min, true);

    const res = evaluatePattern(compiled, new Uint8Array(buf));
    assert.equal(res.status, 'complete');
    assert.equal(typeof res.value.fields.belowMin.value, 'bigint');
    assert.equal(res.value.fields.belowMin.value, belowMin);
    assert.equal(typeof res.value.fields.atMin.value, 'number');
    assert.equal(res.value.fields.atMin.value, Number.MIN_SAFE_INTEGER);
    assert.equal(typeof res.value.fields.int64Min.value, 'bigint');
    assert.equal(res.value.fields.int64Min.value, int64Min);
  });

  it('P1-2: normalizes agent tools models Map key to function start address for interior lookups', async () => {
    let analyzeCalls = 0;
    const makeModel = (addr, truncated = false) => {
      const model = buildSemanticModel([{ row: 0, address: addr, mn: 'ret', ops: '' }], [], []);
      irFor(model).truncated = truncated;
      return model;
    };

    const tools = createAgentTools({
      program: {
        functionRange(addr) {
          const a = typeof addr === 'bigint' ? addr : BigInt(addr);
          if (a >= 0x1000n && a < 0x1040n) return { start: 0x1000n, end: 0x1040n };
          if (a >= 0x2000n && a < 0x2040n) return { start: 0x2000n, end: 0x2040n };
          return null;
        },
      },
      candidateFunctions: [0x1000n],
      async analyze(addr) {
        analyzeCalls += 1;
        const a = typeof addr === 'bigint' ? addr : BigInt(addr);
        if (a >= 0x2000n) return makeModel(0x2000n, true);
        return makeModel(0x1000n, false);
      },
    });

    const first = await tools.get_semantic_facts(0x1004);
    assert.equal(first.complete, true);
    assert.notEqual(first.reason, 'semantic-ir-unavailable');
    assert.equal(analyzeCalls, 1);

    const second = await tools.get_semantic_facts(0x1008);
    assert.equal(second.complete, true);
    assert.equal(second.reason, null);
    assert.equal(analyzeCalls, 1, 'interior address should reuse cached function analysis');

    const constRes = await tools.find_constant(42, { functions: [0x100c] });
    assert.equal(constRes.complete, true);
    assert.equal(constRes.reason, null);

    const truncFirst = await tools.get_semantic_facts(0x2004);
    assert.equal(truncFirst.complete, false);
    assert.equal(truncFirst.reason, 'semantic-ir-truncated');

    const truncSecond = await tools.get_semantic_facts(0x200c);
    assert.equal(truncSecond.complete, false);
    assert.equal(truncSecond.reason, 'semantic-ir-truncated');
  });

  it('P2-3: AnalysisScheduler.request() rejects asynchronously on invalid priority instead of throwing synchronously', async () => {
    const { scheduler: s } = scheduler({ maxConcurrency: 1 });
    let threwSync = false;
    let promise;
    try {
      promise = s.request({
        descriptor: descriptor('bad-priority'),
        priority: 'invalid-priority',
        produce: async () => ({ ok: true }),
      });
    } catch {
      threwSync = true;
    }
    assert.equal(threwSync, false, 'request() must not throw synchronously');
    await assert.rejects(promise, (err) => err instanceof TypeError && /analysis-priority-invalid/.test(err.message));

    const negPromise = s.request({
      descriptor: descriptor('neg-priority'),
      priority: -1,
      produce: async () => ({ ok: true }),
    });
    await assert.rejects(negPromise, (err) => err instanceof TypeError && /analysis-priority-invalid/.test(err.message));
  });

  it('P2-4: canonicalDependencies() uses consistent UTF-16 code unit ordering for actual and expected', async () => {
    const { scheduler: s } = scheduler({ maxConcurrency: 2 });
    const depA = descriptor('dep_A');
    const depa = descriptor('dep_a');
    const depUnderscore = descriptor('dep__');
    const parent = createArtifactDescriptor({
      binaryId: 'bin_phase4_scheduler_fixture',
      artifactKind: 'phase4-scheduler-fixture',
      producerId: 'phase4-scheduler-tests',
      producerVersion: '1',
      versions: { loader: 'fixture-1' },
      relevance: { architectureSemantic: false, abiSemantic: false, semanticSchema: false },
      config: { name: 'parent' },
      upstreamArtifactIds: [depa.artifactId, depA.artifactId, depUnderscore.artifactId].sort(),
    });

    const result = await s.request({
      descriptor: parent,
      dependencies: [
        { descriptor: depa, produce: async () => ({ id: 'a' }) },
        { descriptor: depA, produce: async () => ({ id: 'A' }) },
        { descriptor: depUnderscore, produce: async () => ({ id: '_' }) },
      ],
      produce: async ({ dependencies: results }) => ({ count: results.length }),
    });

    assert.equal(result.payload.count, 3);
  });

  it('P2-5: typeCheckPattern rejects non-array, empty, and non-object module.structs entries with contract errors', () => {
    const validStruct = { kind: 'struct', name: 'Valid', fields: [{ name: 'x', type: { kind: 'primitive', name: 'u8' } }] };

    for (const badStructs of [null, undefined, 'bad', 123, {}, []]) {
      assert.throws(
        () => typeCheckPattern({ kind: 'module', structs: badStructs }),
        (err) => err instanceof TypeError && err.code === 'pattern-module-structs-invalid',
      );
    }

    for (const badEntry of [null, undefined, 42, 'str', []]) {
      assert.throws(
        () => typeCheckPattern({ kind: 'module', structs: [validStruct, badEntry] }),
        (err) => err instanceof TypeError && err.code === 'pattern-root-must-be-struct',
      );
    }
  });
});
