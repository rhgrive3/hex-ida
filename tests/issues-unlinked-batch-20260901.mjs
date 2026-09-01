// Regressions for the unlinked-issue batch: one block per issue number.
import assert from 'node:assert/strict';
import test from 'node:test';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// #3269 + #3264 — Rust metadata completeness and v0 trailing bytes.
{
  const { RustMetadataProvider, demangleRustV0 } = await import('../js/metadata/rust.js');

  const trailing = demangleRustV0('_RC3fooJUNK');
  assert.equal(trailing.parsed, false);
  assert.equal(trailing.reason, 'unconsumed-v0-trailing-bytes');
  const vendorSuffix = demangleRustV0('_RNvC3foo.llvm.123');
  assert.equal(vendorSuffix.parsed, true);
  assert.equal(vendorSuffix.demangled, 'foo');
  const clean = demangleRustV0('_RC3foo');
  assert.equal(clean.parsed, true);
  assert.equal(clean.crate, 'foo');

  const candidateFail = new RustMetadataProvider({
    symbols: [
      { name: '_RC3foo', address: 0x1000n },
      { name: '_R?', address: 0x2000n },
    ],
  }).probe();
  assert.equal(candidateFail.identity.verdict, 'matched-partial');
  assert.equal(candidateFail.completeness.complete, false);
  assert.equal(candidateFail.completeness.unreadableEntries, 1);

  const nonRust = new RustMetadataProvider({
    symbols: [
      { name: '_RC3foo', address: 0x1000n },
      { name: 'someCFunc', address: 0x2000n },
    ],
  }).probe();
  assert.equal(nonRust.identity.verdict, 'matched-authoritative');
  assert.equal(nonRust.completeness.complete, true);
  assert.equal(nonRust.completeness.unreadableEntries, 0);
}

// #3263 — Analysis Query artifactVersions structured identity laundering.
{
  const { createAppAnalysisQueryAdapter } = await import('../js/analysis/query/product-adapter.js');
  const make = (architecture) => ({
    store: new Map([['architecture', architecture], ['instructionAlignment', 4], ['sliceIndex', 1]]),
    backend: { binaryId: 'bin' },
  });
  const primitive = await createAppAnalysisQueryAdapter(make('arm64')).currentIdentity();
  const structured = await createAppAnalysisQueryAdapter(make(['arm64'])).currentIdentity();
  assert.equal(primitive.artifactVersions.architecture, 'arm64');
  assert.notEqual(structured.artifactVersions.architecture, 'arm64');
  const { createAnalysisSnapshot } = await import('../js/analysis/query/snapshot.js');
  const snapPrimitive = createAnalysisSnapshot({ binaryId: 'bin', artifactVersions: primitive.artifactVersions });
  const snapStructured = createAnalysisSnapshot({ binaryId: 'bin', artifactVersions: structured.artifactVersions });
  assert.notEqual(snapPrimitive.snapshotId, snapStructured.snapshotId);
}

// #3259 / #3252 / #3256 — symbolic executor width, budget, and constructor authority.
{
  const { symbolic, SYM, symbolicExecute, expressionText } = await import('../js/symbolic/executor.js');

  const overridden = symbolic('x', { kind: SYM.CONST, value: 1n, source: 'argument', index: 0 });
  assert.equal(overridden.kind, SYM.SYMBOL);
  assert.equal(overridden.name, 'x');
  assert.equal(overridden.source, 'argument');
  assert.equal(symbolic('x', { name: 'y' }).name, 'x');

  const ir = {
    entry: 0,
    blocks: [{
      index: 0, phis: [], succ: [], pred: [],
      insts: [{ id: 'i0', row: 0, op: 'ret', args: [] }],
    }],
  };
  for (const [name, value] of [['maxPaths', ['1']], ['maxSteps', ['10']], ['maxBranches', true], ['maxBlockVisits', ['2']], ['timeoutMs', '50']]) {
    assert.throws(() => symbolicExecute(ir, { [name]: value }), TypeError, `${name} structured budget must fail closed`);
  }
  const budgeted = symbolicExecute(ir, { maxPaths: 4, maxSteps: 500, timeoutMs: 100 });
  assert.equal(budgeted.paths.length, 1);
  assert.equal(budgeted.truncated, false);

  const malformed = { kind: SYM.OP, op: 'add', args: [], bits: ['8'] };
  assert.equal(expressionText(malformed).includes('i8'), false);
  const valid = { kind: SYM.OP, op: 'add', args: [], bits: 8 };
  assert.match(expressionText(valid), /^i8/);
}

// #3245 — SAT model validation rejects non-boolean BOOL bindings.
{
  const { validateSatModel } = await import('../js/symbolic/verify/validate-model.js');
  const { createFreshSymbol } = await import('../js/symbolic/expr/factory.js');
  const { boolSort } = await import('../js/symbolic/expr/kinds.js');
  const flag = createFreshSymbol(boolSort(), 'flag');
  const query = { constraints: [flag] };
  for (const bad of ['false', 1, {}, [], { value: 'x' }]) {
    const result = validateSatModel(query, { flag: bad });
    assert.equal(result.valid, false, `binding ${JSON.stringify(bad)} must not validate`);
    assert.equal(result.reason, 'constraint-violation');
    assert.equal(result.detail.evalReason, 'malformed-boolean-binding');
  }
  assert.deepEqual(validateSatModel(query, { flag: true }), { valid: true });
  assert.equal(validateSatModel(query, { flag: { value: false } }).valid, false);
}

// #3238 — proof cache gate requires complete five-axis completeness.
{
  const { isCacheableProof } = await import('../js/symbolic/evidence/cache-policy.js');
  const base = {
    verdict: 'proved',
    solverStatus: 'unsat',
    completeness: null,
    proofAuthority: 'exact',
    capabilityFingerprint: 'fp',
    backendId: 'solver',
    backendVersion: '1',
    preconditionStatus: 'satisfiable',
  };
  assert.equal(isCacheableProof(base), false, 'missing completeness must not be cacheable');
  const complete = {
    translation: 'complete', controlFlow: 'complete', memoryEffects: 'complete',
    pathCoverage: 'complete', queryScope: 'complete',
  };
  assert.equal(isCacheableProof({ ...base, completeness: complete }), true);
  for (const axis of Object.keys(complete)) {
    const partial = { ...complete, [axis]: 'partial' };
    assert.equal(isCacheableProof({ ...base, completeness: partial }), false, `${axis} partial must not be cacheable`);
  }
  assert.equal(isCacheableProof({ ...base, completeness: {} }), false, 'empty completeness object must not be cacheable');
}

// #3215 — global reachability rejects placeholder PHI evidence.
{
  const { verifyGlobalEdgeReachability } = await import('../js/symbolic/verify/global-reachability.js');
  const { ExhaustiveBvBackend } = await import('../js/symbolic/solver/exhaustive-backend.js');
  const { createBv, createCompare, createFreshSymbol } = await import('../js/symbolic/expr/factory.js');
  const { bvSort, BV_COMPARE_OP } = await import('../js/symbolic/expr/kinds.js');
  const x = createFreshSymbol(bvSort(2), 'global_x');
  const incoming = createCompare(BV_COMPARE_OP.EQ, x, createBv(2, 1n));
  const targetEdge = createCompare(BV_COMPARE_OP.EQ, x, createBv(2, 0n));
  const scope = {
    entryBlock: 0, targetBlock: 5,
    incomingPaths: [{ id: 'entry-path', fromBlock: 0, toBlock: 5, complete: true, condition: incoming }],
    loopBounds: { complete: true, bounds: [] },
    pathCoverageEvidence: { complete: true, coveredPaths: 1, totalPaths: 1 },
    entryPreconditions: [], branchPredicates: [],
  };
  const placeholder = await verifyGlobalEdgeReachability({
    entryBlock: 0, targetBlock: 5, targetEdge, pathCompleteness: 'complete',
    backend: new ExhaustiveBvBackend(), globalScope: { ...scope, phiChoices: [{ complete: true }] },
  });
  assert.equal(placeholder.verdict, 'unknown');
  assert.equal(placeholder.reasonCode, 'incomplete-phi-choices');
  const countedButEmpty = await verifyGlobalEdgeReachability({
    entryBlock: 0, targetBlock: 5, targetEdge, pathCompleteness: 'complete',
    backend: new ExhaustiveBvBackend(), globalScope: { ...scope, phiChoices: [], phiInventory: { count: 2, complete: true } },
  });
  assert.equal(countedButEmpty.verdict, 'unknown');
  assert.equal(countedButEmpty.reasonCode, 'missing-phi-choices');
  const identified = await verifyGlobalEdgeReachability({
    entryBlock: 0, targetBlock: 5, targetEdge, pathCompleteness: 'complete',
    backend: new ExhaustiveBvBackend(), globalScope: { ...scope, phiChoices: [{ complete: true, phi: 'p1', predecessor: 0 }] },
  });
  assert.equal(identified.verdict, 'proved');
}

// #3195 — waitForAppProducer collects abort between pre-check and subscribe.
{
  // The helper is module-private and the module touches window at import, so
  // the regression is a source-anchored guard: the post-subscribe re-check
  // that collects an abort between the pre-check and listener registration
  // must stay present.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('function waitForAppProducer'), source.indexOf('class App'));
  assert.match(helper, /addEventListener\('abort', onAbort/);
  assert.match(helper, /signal\?\.aborted && !done/, 'post-subscribe re-check must collect the late abort');
}

// #3185 — agent tool field key is a strict non-empty primitive string.
{
  const { createAgentTools, AgentToolError } = await import('../js/agent/tools.js');
  const tools = createAgentTools({ program: {}, candidateFunctions: [] });
  for (const bad of [['player.hp'], { toString: () => 'player.hp' }, 5, true]) {
    await assert.rejects(
      () => tools.find_field_writers(0x1000n, { key: bad }),
      (error) => error instanceof AgentToolError && error.code === 'invalid-argument'
        && /field key/.test(error.message),
    );
  }
}

// #3149 / #3148 / #3145 — ARM64 soundness boundaries.
{
  const { liftArm64MachineEffects } = await import('../js/targets/architecture/arm64/effects/index.js');
  const fp = (float) => liftArm64MachineEffects({
    instructionId: 't-fp', mnemonic: 'fcmeq', mode: 'a64',
    ops: [
      { k: 'reg', cls: 'fp', num: 0, bits: 64, text: 'd0' },
      { k: 'reg', cls: 'fp', num: 1, bits: 64, text: 'd1' },
      { k: 'imm', float, text: '#0.0' },
    ],
    origin: { instructionIds: ['t-fp'] },
  });
  assert.equal(fp(0).completeness, 'exact-with-intrinsic');
  for (const bad of ['0', [0], false]) {
    assert.notEqual(fp(bad).completeness, 'exact-with-intrinsic', `float ${JSON.stringify(bad)} must not mint an FP zero`);
  }

  const vec = (arr) => liftArm64MachineEffects({
    instructionId: 't-vec', mnemonic: 'add', mode: 'a64',
    ops: [0, 1, 2].map((n) => ({ k: 'reg', cls: 'vec', num: n, bits: 128, arr, text: `v${n}.16b` })),
    origin: { instructionIds: ['t-vec'] },
  });
  assert.equal(vec('16b').completeness, 'exact-with-intrinsic');
  assert.notEqual(vec(['16b']).completeness, 'exact-with-intrinsic');

  const gp = (mnemonic) => liftArm64MachineEffects({
    instructionId: 't-gp', mnemonic, mode: 'a64',
    ops: [0, 1, 2].map((n) => ({ k: 'reg', cls: 'gp', num: n, bits: 64, text: `x${n}` })),
    origin: { instructionIds: ['t-gp'] },
  });
  assert.equal(gp('add').completeness, 'exact');
  assert.equal(gp(['add']), null, 'structured mnemonic must not claim an integer family');
  assert.equal(gp({ toString: () => 'add' }), null, 'coercion-object mnemonic must not claim an integer family');

  const ccmp = (value) => liftArm64MachineEffects({
    instructionId: 't-ccmp', mnemonic: 'ccmp', mode: 'a64',
    ops: [
      { k: 'reg', cls: 'gp', num: 0, bits: 64, text: 'x0' },
      { k: 'imm', value, text: `#${String(value)}` },
      { k: 'imm', value: 5n, text: '#5' },
      { k: 'cond', text: 'eq' },
    ],
    origin: { instructionIds: ['t-ccmp'] },
  });
  assert.equal(ccmp(31n).completeness, 'exact');
  for (const bad of ['31', 31, [31]]) {
    assert.notEqual(ccmp(bad).completeness, 'exact', `structured immediate ${JSON.stringify(bad)} must not mint a definite conditional compare`);
  }
}

// #3118 — semantic ABI adapter rejects structured argument metadata.
{
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../js/analysis/semantic-function-base.js', import.meta.url), 'utf8');
  const arg = source.slice(source.indexOf('argumentLocations({ functionPrototype'), source.indexOf('return Object.freeze(this.argumentLocations'));
  assert.doesNotMatch(arg, /String\(register \|\| ''\)/, 'register identity must not be String-coerced');
  assert.match(arg, /typeof reg === 'string' && reg\.trim\(\) !== ''/, 'registers must be canonical non-empty strings');
  assert.match(arg, /typeof entry\.index === 'number' && Number\.isSafeInteger/, 'indices must be explicit safe integers');
  assert.doesNotMatch(arg, /Number\.isInteger\(Number\(entry\.index\)\)/, 'indices must not be Number-coerced');
}

// #3139 — semantic instruction geometry rejects structured values.
{
  const { partitionDecodedFunction } = await import('../js/analysis/semantic-function.js');
  const plugin = { classifyControlFlow: () => 'fallthrough', directControlTarget: () => null };
  const ins = (address, length) => ({ address, length, mnemonic: 'nop', ops: [] });
  assert.doesNotThrow(() => partitionDecodedFunction([ins(0x1000n, 4), ins(0x1004n, 4)], plugin));
  assert.doesNotThrow(() => partitionDecodedFunction([ins(4096, 4), ins(4100, 4)], plugin));
  assert.throws(() => partitionDecodedFunction([ins(['4096'], ['4'])], plugin), TypeError);
  assert.throws(() => partitionDecodedFunction([ins({ toString: () => '4096' }, 4)], plugin), TypeError);
}

// #3052 / #3053 — discovery producer identity and fusion budget.
{
  const { DiscoveryProducerRegistry, fuseFunctionCandidates } = await import('../js/analysis/discovery/fusion.js');
  const registry = new DiscoveryProducerRegistry();
  for (const bad of [['p1'], { toString: () => 'p1' }, 5, '']) {
    assert.throws(() => registry.register({ id: bad, produce: () => [] }), TypeError);
  }
  registry.register({
    id: 'p1', architectureId: null,
    produce: () => [{ kind: 'symbol-table', authority: 'corroborating', start: '4096', extentRole: 'complete', regions: [] }],
  });
  const collected = registry.collect({}, 'arm64');
  assert.equal(collected.evidence[0].producerId, 'p1');

  const evidence = (start, producerId) => ({
    kind: 'symbol-table', authority: 'corroborating', start, extentRole: 'complete', regions: [], producerId,
  });
  const rows = [evidence('4096', 'a'), evidence('4096', 'b'), evidence('8192', 'a')];
  assert.throws(() => fuseFunctionCandidates(rows, { budget: { maxEvidencePerCandidate: ['1'] } }), TypeError);
  assert.throws(() => fuseFunctionCandidates(rows, { budget: { maxCandidates: true } }), TypeError);
  assert.throws(() => fuseFunctionCandidates(rows, { budget: [1] }), TypeError);
  const defaulted = fuseFunctionCandidates(rows, {});
  assert.equal(defaulted.candidates.length, 2);
  assert.equal(defaulted.status.completeness, 'complete');
  const truncated = fuseFunctionCandidates(rows, { budget: { maxEvidencePerCandidate: 1 } });
  assert.equal(truncated.candidates.some((c) => c.conflicts.some((x) => x.kind === 'evidence-budget')), true);
  const capped = fuseFunctionCandidates(Array.from({ length: 5 }, (_, i) => evidence(String(0x1000 + i * 0x10), 'a')), { budget: { maxCandidates: 3 } });
  assert.equal(capped.status.stopReason, 'budget-exhausted');
}

// #3006 — debugger module refresh treats malformed typed snapshots as changes.
{
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../js/runtime/debugger-provider.js', import.meta.url), 'utf8');
  assert.match(source, /malformed:\$\{typeof value\}/, 'sameModuleBinding must tag malformed scalar types');
}

// #3003 — runtime authority epoch/sequence require primitive numbers.
{
  const authority = await import('../js/runtime/authority.js');
  const base = {
    providerIdentity: 'p', runtimeInstanceIdentity: 'ri', targetIdentity: 't',
    binaryIdentity: 'b', buildIdentity: 'bi', moduleIdentity: 'm', loadMappingIdentity: 'lm',
    sessionIdentity: 's', capabilityVersion: 'cv',
  };
  assert.throws(() => authority.createRuntimeAuthorityBinding({ ...base, epoch: '7' }), TypeError);
  assert.throws(() => authority.createRuntimeAuthorityBinding({ ...base, epoch: ['7'] }), TypeError);
  assert.equal(authority.createRuntimeAuthorityBinding({ ...base, epoch: 7 }).epoch, 7);
  const binding = authority.createRuntimeAuthorityBinding(base);
  assert.throws(() => authority.createRuntimeObservation({ binding, sequence: '3', observedAt: '2026-01-01T00:00:00Z', kind: 'obs' }), TypeError);
  assert.equal(
    authority.createRuntimeObservation({ binding, sequence: 3, observedAt: '2026-01-01T00:00:00Z', kind: 'obs' }).sequence,
    3,
  );
}

// #2975 — runtime evidence bridge rejects structured authority inputs.
{
  const { RuntimeEvidenceBridge, conservativeCompleteness } = await import('../js/runtime/evidence-bridge.js');
  assert.throws(() => conservativeCompleteness(['complete']), (e) => e.code === 'runtime-invalid-completeness');
  assert.equal(conservativeCompleteness('complete', 'partial'), 'partial');
  const bridge = new RuntimeEvidenceBridge();
  const event = { kind: 'paused', runtimeSessionId: 's', providerId: 'p', providerVersion: '1', sequence: 1, timestamp: '2026-01-01T00:00:00Z' };
  assert.throws(
    () => bridge.eventToEvidence(event, null, { confidence: ['0.98'] }),
    (e) => e.code === 'runtime-invalid-confidence',
  );
  assert.throws(
    () => bridge.eventToEvidence(event, null, { confidence: true }),
    (e) => e.code === 'runtime-invalid-confidence',
  );
  const evidence = bridge.eventToEvidence(event, null, { confidence: 0.5 });
  assert.equal(evidence.confidence, 0.5);
  assert.throws(
    () => bridge.linkClaim('c1', 'e1', ['supports'], { state: 'exact', targetEntityIds: ['t1'] }),
    (e) => e.code === 'runtime-invalid-evidence-relation',
  );
}

// #2973 — trace provider requires canonical identity evidence strings.
{
  const { TraceProvider } = await import('../js/runtime/trace-provider.js');
  const recording = (identityEvidenceIds, identityState = 'resolved') => new TraceProvider({
    recordingId: 'r1', schemaVersion: '1', binaryId: 'bin', events: [], dropped: 0, completeness: 'partial',
    modules: [{ id: 'm1', runtimeBase: 0x1000n, runtimeSize: 0x100n, staticBase: 0x2000n, binaryId: 'attacker-bin', identityState, identityEvidenceIds }],
  });
  const load = async (provider) => {
    const session = await provider.openSession({});
    const binding = session.modules.get('m1');
    return `${binding.identityState}/${binding.binaryId ?? 'null'}`;
  };
  assert.equal(await load(recording(['  '])), 'unresolved/null', 'whitespace-only evidence must not prove identity');
  assert.equal(await load(recording([])), 'unresolved/null', 'empty evidence must not prove identity');
  assert.equal(await load(recording(['ev-1'])), 'resolved/attacker-bin');
  assert.equal(await load(recording(['ev-1'], 'exact')), 'exact/attacker-bin');
}

// #3246 / #3247 — FreshSymbol structural identity equals solver binding identity,
// and serialize/deserialize preserves the saved symbolId.
{
  const { createFreshSymbol, resetSymbolCounterForTesting } = await import('../js/symbolic/expr/factory.js');
  const { boolSort } = await import('../js/symbolic/expr/kinds.js');
  const { computeStructuralHash, structuralEquals } = await import('../js/symbolic/expr/hash.js');
  const { exprToPlain, plainToExpr } = await import('../js/symbolic/expr/serialize.js');

  resetSymbolCounterForTesting(0);
  const a = createFreshSymbol(boolSort(), 'x');
  const b = createFreshSymbol(boolSort(), 'x');
  assert.notEqual(a.symbolId, b.symbolId);
  assert.notEqual(computeStructuralHash(a), computeStructuralHash(b));
  assert.equal(structuralEquals(a, b), false);
  assert.equal(structuralEquals(a, a), true);

  const plain = exprToPlain(a);
  createFreshSymbol(boolSort(), 'other');
  const roundTrip = plainToExpr(plain);
  assert.equal(roundTrip.symbolId, plain.symbolId);
  assert.equal(computeStructuralHash(roundTrip), computeStructuralHash(a));
  assert.equal(structuralEquals(roundTrip, a), true);
  const next = createFreshSymbol(boolSort(), 'x');
  assert.notEqual(next.symbolId, a.symbolId, 'allocator must advance past restored ids');
}

await tick();
console.log('unlinked batch regressions: PASS');
