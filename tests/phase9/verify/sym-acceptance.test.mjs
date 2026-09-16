import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BV_BINARY_OP,
  BV_COMPARE_OP,
  bvSort,
} from '../../../js/symbolic/expr/kinds.js';
import {
  createBinary,
  createBv,
  createCompare,
  createFreshSymbol,
  evaluateExpr,
} from '../../../js/symbolic/expr/index.js';
import {
  SolverBackend,
  PROOF_AUTHORITY,
  isExactProofBackend,
} from '../../../js/symbolic/solver/backend.js';
import { BitBlastBvBackend } from '../../../js/symbolic/solver/bitblast-backend.js';
import { ExhaustiveBvBackend, EXHAUSTIVE_BACKEND_ID } from '../../../js/symbolic/solver/exhaustive-backend.js';
import {
  SolverRegistry,
  createProductionSolverRegistry,
  defaultSolverRegistry,
} from '../../../js/symbolic/solver/registry.js';
import { SOLVER_STATUS, createSolverResult } from '../../../js/symbolic/solver/result.js';
import { SolverSession } from '../../../js/symbolic/solver/session.js';
import { TieredBvBackend, classifyTieredQuery } from '../../../js/symbolic/solver/tiered-backend.js';
import {
  CLAIM_KIND,
  VERDICT,
  VERIFICATION_QUERY_KIND,
  createVerificationQuery,
  validateVerificationQuery,
} from '../../../js/symbolic/verify/query.js';
import { validateSatModel } from '../../../js/symbolic/verify/validate-model.js';
import { verifyBoundedEquivalence } from '../../../js/symbolic/verify/equivalence.js';

import { createByteMemory } from '../../../js/symbolic/memory/byte-memory.js';
import { symbolicExecute } from '../../../js/symbolic/executor.js';
import { OP, MK } from '../../../js/ir.js';

import { queryTaint, createTaintModels, projectTaint } from '../../../js/symbolic/index.js';
import { EvidenceGraph } from '../../../js/core/evidence/index.js';
import { identity, scalarFixture, integrationFixture } from '../taint/fixtures.mjs';

// =============================================================================
// HEX-SYM-01: Symbolic Solver Adapters, Registry, Tiers, SAT/UNSAT
// =============================================================================

function symQuery(assertion = null, constraints = [], targetEntity = 'sym-acceptance') {
  return createVerificationQuery({
    kind: VERIFICATION_QUERY_KIND.CONDITIONAL_EDGE_FEASIBILITY,
    claimKind: CLAIM_KIND.EDGE_INFEASIBLE,
    targetEntity,
    constraints,
    assertion,
  });
}

function equality(symbol, value) {
  return createCompare(BV_COMPARE_OP.EQ, symbol, createBv(symbol.sort.width, value));
}

class ControlledExactBackend extends SolverBackend {
  constructor({ id = 'controlled-exact', width = 64, delayMs = 0, resultFactory } = {}) {
    super({ id, version: '1.0.0', proofAuthority: PROOF_AUTHORITY.EXACT, requiresCanonicalQueryIdentity: true });
    this.width = width;
    this.delayMs = delayMs;
    this.resultFactory = resultFactory;
  }

  baseCapabilities() {
    return {
      ...super.baseCapabilities(),
      supportedSorts: ['bool', 'bv'],
      maxBvWidth: this.width,
      exactProofs: true,
      supportsModelExtraction: true,
      maxConstraints: 4096,
      maxExprNodes: 100000,
      maxExprDepth: 1024,
    };
  }

  createSession() {
    const backend = this;
    return new class extends SolverSession {
      async _executeCheck(q) {
        if (backend.delayMs) await new Promise((resolve) => setTimeout(resolve, backend.delayMs));
        return backend.resultFactory(q, backend);
      }
    }(backend);
  }
}

test('HEX-SYM-01: Production default is a branded exact 64-bit tiered QF_BV backend with trust gating', () => {
  const backend = defaultSolverRegistry.getDefaultBackend();
  assert.ok(backend instanceof TieredBvBackend);
  assert.equal(isExactProofBackend(backend), true);
  const capabilities = backend.capabilities();
  assert.equal(capabilities.maxBvWidth, 64);
  assert.equal(capabilities.exhaustiveMaxBvWidth, 8);
  assert.equal(capabilities.routingPolicy, 'exhaustive-oracle-then-bitblast-v1');
  assert.equal(capabilities.exactProofs, true);

  // Trust contract: forged/tampered backends cannot become exact default
  const registry = new SolverRegistry({ allowNonExactDefault: false });
  const forged = { id: 'forged-exact', proofAuthority: 'exact' };
  registry.registerBackend(forged);
  assert.equal(isExactProofBackend(forged), false);
  assert.notEqual(registry.getDefaultBackend(), forged);
  assert.equal(registry.getDefaultBackend(), null);

  registry.registerBackend(new ExhaustiveBvBackend());
  assert.throws(() => registry.setDefaultBackend('forged-exact'), /not an exact production backend/);
  registry.setDefaultBackend(EXHAUSTIVE_BACKEND_ID);
  assert.equal(registry.getDefaultBackend().constructor.name, 'ExhaustiveBvBackend');
});

test('HEX-SYM-01: Tier classifier routes <=8-bit to exhaustive oracle and 32/64-bit to bitblast', () => {
  const x4 = createFreshSymbol(bvSort(4), 'route4');
  const q4 = symQuery(equality(x4, 3n));
  assert.equal(classifyTieredQuery(q4).tier, 'exhaustive-oracle');

  for (const width of [32, 64]) {
    const x = createFreshSymbol(bvSort(width), `route${width}`);
    const routed = classifyTieredQuery(symQuery(equality(x, 7n)));
    assert.equal(routed.supported, true);
    assert.equal(routed.tier, 'bitblast-qfbv');
    assert.equal(routed.maxBvWidth, width);
  }
});

test('HEX-SYM-01: 32/64-bit SAT model extraction with independent validation and immutable witness', async () => {
  const backend = new TieredBvBackend();
  for (const width of [32, 64]) {
    const x = createFreshSymbol(bvSort(width), `wide_x_${width}`);
    const y = createFreshSymbol(bvSort(width), `wide_y_${width}`);
    const xValue = width === 32 ? 0x12345678n : 0x123456789abcdef0n;
    const yValue = width === 32 ? 0x10203040n : 0x0102030405060708n;
    const expression = createBinary(BV_BINARY_OP.XOR, createBinary(BV_BINARY_OP.ADD, x, y), y);
    const expected = BigInt.asUintN(width, (xValue + yValue) ^ yValue);
    const q = symQuery(
      createCompare(BV_COMPARE_OP.EQ, expression, createBv(width, expected)),
      [equality(x, xValue), equality(y, yValue)],
      `wide-sat-${width}`,
    );
    const result = await backend.createSession({ timeoutMs: 3000 }).check(q, { timeoutMs: 3000 });
    assert.equal(result.status, SOLVER_STATUS.SAT, `BV${width} SAT`);
    assert.equal(result.stats.routingTier, 'bitblast-qfbv');
    assert.equal(result.stats.engineBackend, 'hex-bitblast-qfbv');
    assert.equal(validateSatModel(q, result.model).valid, true);
    assert.throws(() => result.model.set(x.symbolId, 0n), /read-only/, 'validated witness must be immutable');
    assert.equal(result.lifecycle.publishable, true);
  }
});

test('HEX-SYM-01: Wide contradiction returns UNSAT; small-domain overlap requires exact agreement', async () => {
  const backend = new TieredBvBackend();
  const wide = createFreshSymbol(bvSort(32), 'wide_unsat');
  const wideQuery = symQuery(null, [equality(wide, 1n), equality(wide, 2n)], 'wide-unsat');
  const wideResult = await backend.createSession().check(wideQuery);
  assert.equal(wideResult.status, SOLVER_STATUS.UNSAT);
  assert.equal(wideResult.stats.routingTier, 'bitblast-qfbv');
  assert.equal(wideResult.lifecycle.publishable, true);

  const small = createFreshSymbol(bvSort(4), 'small_unsat');
  const smallQuery = symQuery(null, [equality(small, 1n), equality(small, 2n)], 'small-unsat');
  const smallResult = await backend.createSession().check(smallQuery);
  assert.equal(smallResult.status, SOLVER_STATUS.UNSAT);
  assert.equal(smallResult.stats.routingTier, 'exhaustive-oracle');
  assert.equal(smallResult.stats.agreementPolicy, 'all-overlapping-exact-tiers-v1');
  assert.deepEqual(smallResult.stats.attempts.map((a) => a.status), ['unsat', 'unsat']);
});

test('HEX-SYM-01: Negative boundaries fail closed (tampered hash, corrupt model, mutation, resource, timeout, 65-bit)', async () => {
  const backend = new TieredBvBackend();

  // 1. Tampered query hash
  const x = createFreshSymbol(bvSort(32), 'tamper_x');
  const orig = symQuery(equality(x, 1n), [], 'tamper');
  const forged = structuredClone(orig);
  forged.assertion.right.value = 2n;
  const val = validateVerificationQuery(forged);
  assert.equal(val.valid, false);
  const forgedRes = await backend.createSession().check(forged);
  assert.equal(forgedRes.status, SOLVER_STATUS.INVALID_QUERY);
  assert.equal(forgedRes.lifecycle.publishable, false);

  // 2. Corrupt model from provider rejected
  const corrupt = new ControlledExactBackend({
    id: 'corrupt-wide',
    resultFactory: (qVal, b) => createSolverResult({
      status: SOLVER_STATUS.SAT,
      model: new Map([[x.symbolId, 0x56n]]),
      backend: b.id,
      backendVersion: b.version,
      queryHash: qVal.queryHash,
    }),
  });
  const corruptRes = await new TieredBvBackend({ wideBackend: corrupt }).createSession().check(orig);
  assert.equal(corruptRes.status, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.match(corruptRes.reason, /model-validation-failed/);

  // 3. Provider mutation after registration
  const mutatingWide = new BitBlastBvBackend();
  const mutatingBackend = new TieredBvBackend({ wideBackend: mutatingWide });
  mutatingWide.id = 'mutated-post-registration';
  const mutRes = await mutatingBackend.createSession().check(orig);
  assert.equal(mutRes.status, SOLVER_STATUS.PROVIDER_FAILURE);
  assert.equal(mutRes.reason, 'tier-provider-contract-mismatch:wide');

  // 4. Resource ceiling
  const tinyWide = new BitBlastBvBackend({ maxVariables: 8, maxClauses: 32 });
  const tinyRes = await new TieredBvBackend({ wideBackend: tinyWide }).createSession().check(orig);
  assert.equal(tinyRes.status, SOLVER_STATUS.RESOURCE_LIMIT);
  assert.equal(tinyRes.lifecycle.publishable, false);

  // 5. Timeout & cancellation
  const slow = new ControlledExactBackend({
    id: 'slow-wide',
    delayMs: 50,
    resultFactory: (qVal, b) => createSolverResult({ status: SOLVER_STATUS.UNSAT, backend: b.id, backendVersion: b.version, queryHash: qVal.queryHash }),
  });
  const timed = await new TieredBvBackend({ wideBackend: slow }).createSession().check(orig, { timeoutMs: 5 });
  assert.equal(timed.status, SOLVER_STATUS.TIMEOUT);

  const ctrl = new AbortController();
  const pending = new TieredBvBackend({ wideBackend: slow }).createSession().check(orig, { signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 2);
  assert.equal((await pending).status, SOLVER_STATUS.CANCELLED);

  // 6. >64-bit unsupported
  const x65 = createFreshSymbol(bvSort(65), 'too_wide');
  const res65 = await backend.createSession().check(symQuery(equality(x65, 0n)));
  assert.equal(res65.status, SOLVER_STATUS.UNSUPPORTED);
});

// =============================================================================
// HEX-SYM-02: Byte Memory State, Parity, Escalation, Aliasing, Barriers
// =============================================================================

const memIdentity = Object.freeze({
  queryId: 'sym-mem-acceptance',
  snapshotId: 's-accept-1',
  binaryId: 'bin-1',
  functionId: 'func-1',
  architecture: 'generic',
  addressSpace: 'data',
  semanticsVersion: '2.0.0',
});

const makeMem = (options = {}) => createByteMemory({ identity: memIdentity, ...options });
const readMemValue = (res, env = {}) => {
  assert.ok(res.expression, res.reason);
  const ev = evaluateExpr(res.expression, env);
  assert.equal(ev.status, 'value');
  return ev.value;
};

test('HEX-SYM-02: Byte memory parity and partial overwrite across widths (1,2,4,8) and endians (little,big)', () => {
  for (const endian of ['little', 'big']) {
    for (const size of [1, 2, 4, 8]) {
      const m = makeMem({ endian });
      const n = BigInt.asUintN(size * 8, 0xfedcba9876543210n);
      assert.equal(m.store(0x100n, size, n).status, 'stored');
      assert.equal(readMemValue(m.load(0x100n, size)), n);

      // Overwrite the last byte
      const i = size - 1;
      m.store(0x100n + BigInt(i), 1, 0xaan);
      const shift = BigInt((endian === 'little' ? i : size - 1 - i) * 8);
      const expected = (n & ~(255n << shift)) | (0xaan << shift);
      assert.equal(readMemValue(m.load(0x100n, size)), expected);
    }
  }
});

test('HEX-SYM-02: Concrete-to-symbolic escalation, write order, and distinct symbol non-MustAlias', () => {
  const m = makeMem({ addressBits: 8 });
  m.store(4n, 2, 0x1234n);
  const before = m.load(4n, 2);
  const p = createFreshSymbol(bvSort(8), 'p');
  m.store(p, 1, 0xeen);
  assert.equal(readMemValue(before), 0x1234n);

  for (const a of [4n, 5n, 6n]) {
    assert.equal(readMemValue(m.load(4n, 2), { [p.symbolId]: a }), a === 4n ? 0x12een : a === 5n ? 0xee34n : 0x1234n);
  }

  // Symbol name coincidence does not imply MustAlias
  const m2 = makeMem({ addressBits: 2, initialBytes: [[0n, 1n], [1n, 2n], [2n, 3n], [3n, 4n]] });
  const p1 = createFreshSymbol(bvSort(2), 'same');
  const p2 = createFreshSymbol(bvSort(2), 'same');
  m2.store(p1, 1, 9n);
  assert.equal(readMemValue(m2.load(p2, 1), { [p1.symbolId]: 0n, [p2.symbolId]: 1n }), 2n);
});

test('HEX-SYM-02: Memory barriers, address wrap, budgets, and lookalike rejection fail closed', () => {
  // Barriers
  for (const reason of ['unknown-clobber', 'unknown-call', 'may-alias-clobber']) {
    const m = makeMem();
    m.store(0n, 1, 1n);
    m.barrier(reason);
    assert.equal(m.load(0n, 1).reason, reason);
  }

  for (const flag of ['volatile', 'atomic']) {
    const m = makeMem();
    m.store(0n, 1, 1n);
    assert.equal(m.load(0n, 1, { [flag]: true }).status, 'unknown');
  }

  // 64-bit BigInt addresses and modular wrap
  const high = 0xffffffffffffffffn;
  const mWrap = makeMem({ wrapping: 'modular' });
  assert.equal(mWrap.store(high, 2, 0xbbaan).status, 'stored');
  assert.equal(readMemValue(mWrap.load(high, 1)), 0xaan);
  assert.equal(readMemValue(mWrap.load(0n, 1)), 0xbbn);
  assert.equal(readMemValue(mWrap.load(high, 2)), 0xbbaan);

  // Lookalikes fail closed
  assert.equal(makeMem().store(0n, 1, createBv(16, 1n)).reason, 'width-mismatch');
  assert.equal(makeMem({ alignment: 'natural' }).load(1n, 2).reason, 'alignment-unproved');
  assert.equal(makeMem().load(0n, 1, { addressSpace: 'foreign' }).reason, 'address-space-mismatch');
});

test('HEX-SYM-02: Production executor observes byte overwrite in execution paths', () => {
  const loc = (address, size) => ({ kind: MK.GLOBAL, address, size, key: `global:${address}:size:${size}` });
  const a = { id: 'a', const: 0x11223344n, bits: 32 };
  const b = { id: 'b', const: 0xaan, bits: 8 };
  const dst = { id: 'loaded', bits: 32 };
  const insts = [
    { id: 's0', op: OP.STORE, loc: loc(0x100n, 4), args: [{ value: a }], row: 0 },
    { id: 's1', op: OP.STORE, loc: loc(0x101n, 1), args: [{ value: b }], row: 1 },
    { id: 'l0', op: OP.LOAD, loc: loc(0x100n, 4), args: [], dst, row: 2 },
    { id: 'r0', op: OP.RET, args: [{ value: dst }], row: 3 },
  ];
  dst.def = insts[2];
  const ir = { entry: 0, blocks: [{ index: 0, insts, succ: [] }], instructions: insts };
  const options = { byteMemory: { identity: memIdentity, addressBits: 64, endian: 'little' } };

  const r = symbolicExecute(ir, options);
  assert.equal(r.paths[0]?.returnValue?.value, 0x1122aa44n);
});

// =============================================================================
// HEX-SYM-03: Taint Analysis, Sanitizers, EvidenceGraph, and Bounded Equivalence
// =============================================================================

export const scalarModels = (extras = {}) => createTaintModels({
  id: 'm',
  version: '1',
  provenance: 'fixture:reviewed',
  sources: [{ id: 'external', valueId: 'input' }],
  sinks: [{ id: 'sink', valueId: 'out' }],
  ...extras,
});

const runTaint = (extra = {}) => queryTaint(scalarFixture(), { identity, models: scalarModels(), memory: { addressBits: 8 }, ...extra });

test('HEX-SYM-03: Production source -> partial store -> load -> control/data -> phi -> sink -> EvidenceGraph', () => {
  const models = createTaintModels({
    id: 'integration',
    version: '1',
    provenance: 'fixture:semantic-values',
    sources: [{ id: 'pointer', valueId: 'ptr' }, { id: 'old-word', valueId: 'word' }, { id: 'new-byte', valueId: 'byte' }],
    sinks: [{ id: 'result', valueId: 'final' }, { id: 'control-only', valueId: 'no' }],
  });
  const result = queryTaint(integrationFixture(), { identity, models, timeoutMs: 3000, memory: { addressBits: 8, wrapping: 'modular' } });
  assert.equal(result.status, 'complete', result.reason);
  assert.equal(result.execution.paths.length, 2);
  assert.deepEqual(result.sinks[0].taint.sources, ['new-byte', 'pointer']);
  assert.deepEqual(result.sinks[1].taint.sources, ['new-byte', 'pointer']);
  assert.ok(result.edges.some((e) => e.kind === 'memory-load'));
  assert.ok(result.edges.some((e) => e.kind === 'control'));
  assert.ok(result.edges.some((e) => e.kind === 'phi'));
  assert.equal(result.evidence.proofAuthority, 'none');
  assert.equal(result.evidence.verdict, 'unknown');

  const graph = EvidenceGraph.fromJSON(result.graph);
  assert.deepEqual(graph.unresolvedReferences(), []);
  assert.equal(result.evidence.proofScope.identity.snapshotId, identity.snapshotId);
});

test('HEX-SYM-03: Sanitizers filter declared sources while unknown flags fail closed to TOP/partial', () => {
  const good = scalarModels({ sanitizers: [{ id: 'declared', valueId: 'out', scope: 'value', removeSources: ['external'] }] });
  assert.equal(runTaint({ models: good }).sinks[0].taint.kind, 'untainted');

  const unrelated = scalarModels({ sanitizers: [{ id: 'declared', valueId: 'out', scope: 'value', removeSources: ['other'] }] });
  assert.deepEqual(runTaint({ models: unrelated }).sinks[0].taint.sources, ['external']);

  const unknown = scalarModels({ sanitizers: [{ id: 'sanitize_everything', valueId: 'out', clean: true }] });
  const r = runTaint({ models: unknown });
  assert.deepEqual(r.sinks[0].taint.sources, ['external']);
  assert.deepEqual(r.unknownSanitizers, ['sanitize_everything']);

  // Stale identity or copied record has no projection authority
  let current = identity;
  const proj = runTaint({ getCurrentIdentity: () => current });
  assert.equal(projectTaint({ ...proj }).evidence, null);
  assert.equal(projectTaint(proj, { modelIdentity: 'different' }).evidence, null);
  current = { ...identity, snapshotId: 'stale-snapshot' };
  assert.equal(projectTaint(proj).evidence, null);
});

test('HEX-SYM-03: Bounded equivalence verifies identical expressions, refutes differences, and blocks vacuous proofs', async () => {
  // Proves equivalence: x + x == x << 1
  const x = createFreshSymbol(bvSort(4), 'x');
  const beforeExpr = createBinary(BV_BINARY_OP.ADD, x, x);
  const afterExpr = createBinary(BV_BINARY_OP.SHL, x, createBv(4, 1));
  const backend = new ExhaustiveBvBackend();

  const proved = await verifyBoundedEquivalence({ beforeTarget: beforeExpr, afterTarget: afterExpr, backend });
  assert.equal(proved.verdict, VERDICT.PROVED);
  assert.equal(proved.claimKind, CLAIM_KIND.EQUIVALENT);
  assert.equal(proved.reasonCode, 'proved-equivalent');

  // Refutes non-equivalence: x + 1 != x + 2
  const x4 = createFreshSymbol(bvSort(4), 'x4');
  const diffBefore = createBinary(BV_BINARY_OP.ADD, x4, createBv(4, 1));
  const diffAfter = createBinary(BV_BINARY_OP.ADD, x4, createBv(4, 2));
  const refuted = await verifyBoundedEquivalence({ beforeTarget: diffBefore, afterTarget: diffAfter, backend });
  assert.equal(refuted.verdict, VERDICT.REFUTED);
  assert.equal(refuted.claimKind, CLAIM_KIND.EQUIVALENT);
  assert.equal(refuted.reasonCode, 'observable-difference-found');

  // Vacuous proof guard: inconsistent preconditions fail closed to UNKNOWN
  const p1 = createCompare(BV_COMPARE_OP.EQ, x4, createBv(4, 10));
  const p2 = createCompare(BV_COMPARE_OP.EQ, x4, createBv(4, 12));
  const vacuous = await verifyBoundedEquivalence({
    beforeTarget: diffBefore,
    afterTarget: diffAfter,
    preconditions: [p1, p2],
    backend,
  });
  assert.equal(vacuous.verdict, VERDICT.UNKNOWN);
  assert.equal(vacuous.reasonCode, 'inconsistent-preconditions');
  assert.equal(vacuous.evidence, null);
});
