/** Read-only SCPA tools. Plans, cursors and hypotheses never issue proofs. */
import { MAXIMUM_QUERY_LIMITS, normalizeQueryLimits } from '../../core/budgets/scoped-work.js';
import { snapshotContractData } from '../../core/identity/structured.js';
const string = { type: 'string', minLength: 1, maxLength: 4096 };
const object = { type: 'object' };
const boundInteger = (min, max) => ({ type: 'integer', minimum: min, maximum: max });
const strictObject = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const functionIds = { type: 'array', items: string, minItems: 1, maxItems: 256 };
const cursor = strictObject({ cursor: { type: 'string', minLength: 1, maxLength: 256 } }, ['cursor']);
const query = strictObject({ schema: { type: 'string', enum: ['semantic-query/v1'] },
  scope: strictObject({ functionIds, expectClosed: { type: 'boolean' } }, ['functionIds']),
  select: object, flow: object, projection: object, resultLimit: boundInteger(1, 1024) }, ['scope', 'select']);
const workBudget = strictObject(Object.fromEntries(Object.entries(MAXIMUM_QUERY_LIMITS).map(([key, maximum]) =>
  [key, boundInteger(key === 'yieldEvery' ? 1 : 0, maximum)])));
function withWorkBudget(schema) { return { ...schema, properties: { ...(schema.properties ?? {}), workBudget } }; }
const definitions = [
  ['inspect_demand_obligations', 'demandInvestigationFrontier', strictObject({ artifactId: string, maximumActions: boundInteger(1, 64) }, ['artifactId']),
    'Inspect a published current-world FlowAnswer with the existing deterministic investigation frontier policy. Lists undischarged proof/closure/object/ABI obligations and bounded inspection priorities. Does not invent a job, execute actions, claim a goal complete or change canonical facts.'],
  ['investigate_demand_precision', 'investigateDemand', strictObject({ template: { type: 'string', enum: ['source-to-sink', 'allocation-null-guard', 'length-to-buffer-use'] },
    functionIds: { ...functionIds, maxItems: 8 }, anchors: object, via: { type: 'array', items: object, maxItems: 8 }, avoid: object,
    resultLimit: boundInteger(1, 64), maxDepth: boundInteger(1, 128), maxCallDepth: boundInteger(0, 4), precision: object,
    maximumContexts: boundInteger(1, 32) }, ['template', 'functionIds', 'anchors']),
    'Execute one of three real demand/evidence queries, not just a plan. Anchor pairs are source/sink, allocation/guard, or length/bufferUse semantic selectors. Roles are hypotheses: allocator identity, null-check meaning, dominance and buffer bounds remain explicit obligations. Uses the normal same-world continuation and atomic Explain artifact.'],
  ['query_demand_precision', 'demandQuery', strictObject({
    query: { ...query, properties: { ...query.properties,
      scope: strictObject({ functionIds: { ...functionIds, maxItems: 8 }, expectClosed: { type: 'boolean' } }, ['functionIds']),
      resultLimit: boundInteger(1, 64) } },
    precision: strictObject({ schema: { type: 'string', enum: ['scoped-precision-request/v1'] },
      valueIds: { type: 'array', items: string, maxItems: 64 }, maximumValues: boundInteger(1, 64),
      goals: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string', enum: ['constant', 'known-bits', 'interval', 'congruence', 'alignment', 'pointer-offset'] } } }),
    maximumContexts: boundInteger(1, 32), adaptiveRefinement: strictObject({ enabled: { type: 'boolean', const: true },
      maximumRefinements: boundInteger(0, 32), maximumFamilies: boundInteger(1, 32), warmupSamples: boundInteger(1, 8),
      minimumGain: boundInteger(0, 256), maximumMeasuredWork: boundInteger(0, 8000000) }, ['enabled']) }, ['query']),
    'Run one resumable demand-precision slice over at most eight selected functions. Uses the actual canonical worker, query-selected value facts, object partitions, existing SCC summaries, callsite context bindings and dispatch bounds. The final possible-flow answer and byte/IR/MemorySSA/summary evidence are published atomically in the canonical ArtifactStore. Unfinished phases stay private; no exact negative answer, executable-path or semantic proof is inferred. Default result limit 32.'],
  ['resume_demand_precision', 'resumeDemandQuery', cursor,
    'Consume a single-use same-snapshot demand continuation. Preparation, SCC/context state, evidence and cumulative budgets survive; completed function owners are not reloaded. A cancelled or invalidated answer cannot publish.'],
  ['explain_demand_result', 'explainDemandResult', strictObject({ artifactId: string,
    view: { type: 'string', enum: ['summary', 'answer', 'certificate', 'graph'] }, encoding: { type: 'string', enum: ['canonical', 'shared-dag-v1'] } }, ['artifactId']),
    'Read a published same-world demand answer with dependency validation. Shows scope judgment, current-source evidence, object/value/context facts and open frontier. Graph or certificate availability is not semantic qualification.'],
  ['replay_demand_result', 'replayDemandResult', strictObject({ artifactId: string, level: { type: 'string', enum: ['owners', 'integrity'] } }, ['artifactId']),
    'Replay the published demand certificate against current input bytes and freshly loaded canonical SSA, Phase8 range and points-to owners. Owners is the default; integrity restricts replay to byte/content checks. Contradictory evidence quarantines only the observed stored version. Distinguishes integrity, byte binding and semantic proof. Does not accept untrusted serialized proofs or execute binary code.'],

  ['inspect_task_idiom_view', 'taskIdiomView', strictObject({ functionId:string,
    task:{type:'string',enum:['inspect-bit-condition','trace-value','inspect-memory-order']}, statementIds:{type:'array',items:string,minItems:1,maxItems:16}}, ['functionId','task']),
    'Inspect task-specific source-linked bit-condition idioms. Candidates must lower to an independently checked typed predicate; unchanged/original text, order and unresolved proofs remain present. This is not C-rendering, whole-function proof, measured human readability or permission to rewrite.'],
  ['inspect_conditional_model', 'inspectConditionalModel', strictObject({functionId:string, modelId:string,
    family:{type:'string',enum:['scalable-vector','sme-call-frame','memory-events']}, claim:object}, ['functionId','modelId','family']),
    'Check an explicitly versioned current private-owner model: bounded VL/predicate lanes, normal-return SME frame, or finite constant atomic events. No model may be injected by this tool. A verified model or forbidden-in-model result is NOT native instruction qualification, universal memory-model proof, semantic closure or rewrite permission.'],
  ['check_loop_invariant', 'checkLoopInvariant', strictObject({ functionId: string, loopId: string, synthesize: { type: 'boolean' }, capsule: object,
    invariant: strictObject({ lower: string, upper: string }, ['lower', 'upper']),
    postcondition: strictObject({ lower: string, upper: string }, ['lower', 'upper']) }, ['functionId', 'loopId', 'postcondition']),
    'Supply invariant or synthesize=true (bounded candidate templates). Optional capsule is fully rebound to the current model, not trusted. Check initiation, preservation, exit postconditions and a limited ranking function for a current host-owned unsigned scalar loop model. The query cannot supply a transition model or proof provider. All-iteration model induction is separate from machine/CFG adequacy, executable reachability and whole-function equivalence. No rewrite adoption.'],
  ['inspect_async_event_order', 'asyncEventOrder', strictObject({ runtimeSessionId: string, fromEventId: string, toEventId: string,
    maximumDepth: boundInteger(1, 128), lifetime: strictObject({ objectId: string, objectGeneration: string, useEventId: string }, ['objectId', 'objectGeneration', 'useEventId']) }, ['runtimeSessionId', 'fromEventId', 'toEventId']),
    'Inspect a bounded already-captured event graph under current versioned host library contracts. Same actor, executor or timestamps do not imply order. Cycles, reused one-use tokens, missing edges and incomplete lifetime boundaries stay explicit. No capture, runtime control or universal static happens-before claim.'],
  ['portable_integer_checks', 'portableIntegerChecks', strictObject({ functionId: string, capsule: object }, ['functionId']),
    'Export current source-bound integer proposals for a small provider-free detached checker. With a capsule, reread native owners and bytes and compare the entire capsule before replay. Imported data cannot choose code or a checker. Derivation checks, source currentness and whole-query proof remain separate.'],
  ['inspect_objc_block_captures', 'blockCaptures', strictObject({ functionId: string, blockValueId: string }, ['functionId', 'blockValueId']),
    'Inspect existing ObjC Block field/capture references tied to the same Semantic IR, SSA and MemorySSA owners. Layout recognition, constants, escape, lifetime, byref forwarding and thread order remain unqualified. Does not infer no captures, create targets, alter escape analysis or execute a callback. Requires current canonical block field evidence.'],
  ['inspect_investigation_frontier', 'investigationFrontier', strictObject({ jobId: string,
    hypothesisIds: { type: 'array', items: string, maxItems: 128 }, maximumActions: boundInteger(1, 64),
    includeClaims: { type: 'boolean' }, previousViewId: string, planningBudget: strictObject({ workUnits: boundInteger(0, 10000000), bytesRead: boundInteger(0, 1073741824), residentBytes: boundInteger(0, 1073741824), toolCalls: boundInteger(0, 128) }, ['workUnits', 'bytesRead', 'residentBytes', 'toolCalls']) }, ['jobId']),
    'Read an idle existing job, its namespace-bound hypotheses/evidence headers, formal owner obligations and non-dominated inspection priorities. Returns transport deltas only against a previously issued same-scope view. Evidence counts, model confidence and a job complete flag do not prove the goal. No model/tool/probe execution, job writes or canonical fact mutation.'],
  ['inspect_physical_type_evidence', 'typeEvidence', strictObject({ functionId: string,
    entityIds: { type: 'array', items: string, minItems: 1, maxItems: 64 } }, ['functionId', 'entityIds']),
    'Project existing canonical machine/SSA declarations through the existing type graph in its isolated worker. Widths belong to values or accesses, not guessed language types or object sizes. No exact nominal, layout or prototype claim.'],
  ['query_scoped_interprocedural_flow', 'interproceduralQuery', { ...query, properties: { ...query.properties,
    scope: strictObject({ functionIds: { ...functionIds, maxItems: 16 }, expectClosed: { type: 'boolean' } }, ['functionIds']) } },
    'Compose at most sixteen explicitly selected canonical functions with matching call/return contexts. Bound ABI owner ports are required for cross-function edges. Missing arguments, targets, memory ports and initial caller contexts stay open. Results are possible dependencies, never executable-path or absence proofs. Resume with resume_semantic_flow.'],
  ['inspect_abi_input_bindings', 'abiInputBindings', strictObject({ functionId: string }, ['functionId']),
    'Inspect source-bound 64-bit physical register input candidates from the existing ABI and canonical compatibility projection. Incoming undefined register state stays unknown. No return, stack, aggregate or vector port is inferred; no prototype or exact argument is claimed.'],
  ['inspect_abi_placement_evidence', 'abiPlacementEvidence', strictObject({ functionId: string,
    kind: { type: 'string', enum: ['arguments', 'return'] }, callSiteId: string }, ['functionId', 'kind']),
    'Check an existing canonical ABI classifier result, including aggregate pieces, physical register overlap, stack spans and hidden result pointers. No source-type, prototype or calling-convention guess is promoted to exact evidence. Requires a current host-owned ABI result.'],
  ['explain_transform_proof_chain', 'explainTransformChain', strictObject({ functionId: string,
    stepIds: { type: 'array', items: string, minItems: 1, maxItems: 64 }, includePremises: { type: 'boolean' } }, ['functionId']),
    'With stepIds, replay an ordered pass-receipt chain and bounded premise DAG. Without stepIds, capture the actual bounded native Phase8 view changes and independently check typed expressions and final statement mapping. Whole-function and C-rendering equivalence remain unproved. Links must preserve the same observable contract. Hash integrity, refinement, bounded equivalence and semantic proof remain distinct. This read never accepts a rewrite or mutates IR.'],
  ['reconcile_captured_runtime_observations', 'runtimeObservations', strictObject({ runtimeSessionId: string,
    eventIds: { type: 'array', items: string, minItems: 1, maxItems: 128 },
    role: { type: 'string', enum: ['instruction', 'call-target', 'memory-address'] }, targetEnvelopeId: string }, ['runtimeSessionId', 'eventIds', 'role']),
    'Read only already captured event addresses, bound to exact session, epoch and module generation. Synthetic/intervened samples never become natural-execution facts. Static set disagreement requires the same callsite subject and admitted observation; no experiments, runtime control or static truth writes are performed.'],
  ['explain_knowledge_matches', 'knowledgeMatches', strictObject({ functionId: string, maxCandidates: boundInteger(1, 128), resultLimit: boundInteger(1, 32), cursor: string, versionFamily: string, retrieval: { type: 'string', enum: ['page', 'indexed'] }, maximumIndexRecords: boundInteger(128, 65536), maximumBucketScan: boundInteger(1, 4096) }, ['functionId']),
    'Compare current host-published function fingerprints using the existing recognizer. Page mode has one-use continuations; indexed mode reuses the bounded canonical feature index (maximumIndexRecords must be a multiple of 128). Includes feature contributions, provenance and competing shared-feature candidates. Scores and legacy exact/semantic-equivalent labels remain heuristic; no identity or metadata transfer is authorized.'],
  ['inspect_apple_pointer_site', 'applePointerView', strictObject({ storageAddress: string }, ['storageAddress']),
    'Inspect a bound current-source pointer site from the existing Mach-O loader. Encoded targets, authentication fields and unknowns remain metadata; this does not prove successful PAC authentication or an exact executable target.'],
  ['get_scoped_analysis_capabilities', 'scopedCapabilities', strictObject({}),
    'Inspect experimental scoped-analysis availability and explicit missing capabilities. Presence is not semantic verification.'],
  ['query_semantic_flow', 'semanticQuery', query,
    'Search a bounded explicit function set over canonical IR, SSA and MemorySSA. Returns possible-dependence paths, owner references, unresolved frontier and a resumable cursor. Supports up to eight ordered flow.via selectors and flow.avoid along traversal direction. origin-overlaps {space:file|virtual, sourceId, start, end} selects exact half-open 64-bit recorded origins, not memory targets. Unknown filters remain open; filters are not sanitizer proofs. A path is NOT proof of executable flow; empty results are NOT proof of absence.'],
  ['resume_semantic_flow', 'resumeSemanticQuery', cursor,
    'Consume one current-world semantic-query continuation. Cursors are single-use, budget-preserving, time-limited and cannot survive a world change.'],
  ['resolve_dispatch_targets', 'dispatchTargets', strictObject({ functionId: string, callSiteId: string,
    families: { type: 'array', items: string, maxItems: 32 }, maxTargets: boundInteger(1, 4096), maxHops: boundInteger(1, 64) }, ['functionId', 'callSiteId']),
    'Return candidate targets for a canonical callsite with target-set bounds, provenance, profile/closure obligations and exact-vs-unqualified separation. Metadata or observed targets do not become an exact static set.'],
  ['describe_memory_objects', 'objectMemory', strictObject({ functionId: string, valueId: string }, ['functionId', 'valueId']),
    'Project existing points-to roots into object/lifetime partitions. Geometry is descriptive, not MustAlias/NoAlias or permission for a strong MemorySSA update.'],
  ['explain_scoped_reference_slice', 'referenceSlice', strictObject({ functionId: string, request: strictObject({
    projectionId: string, referenceIds: { type: 'array', items: string, minItems: 1, maxItems: 32 },
    direction: { type: 'string', enum: ['backward', 'forward'] }, maxDepth: boundInteger(0, 16),
    maxNodes: boundInteger(1, 256), includeBytes: { type: 'boolean' },
  }, ['projectionId', 'referenceIds']) }, ['functionId', 'request']),
    'Explain current canonical query references, owner links, origins and optional source bytes. Use projectionId from the selected record reference. This portable JSON is NOT an EvidenceGraph proof, semantic certificate, closure receipt or permission to rewrite.'],
  ['replay_scoped_reference_slice', 'replayReferenceSlice', strictObject({ functionId: string, bundle: object }, ['functionId', 'bundle']),
    'Recompute an explanation and compare its full current-source content, including requested origin bytes. An ID hash alone cannot pass. Equality is not a proof of instruction semantics, path feasibility or completeness.'],
  ['inspect_scoped_call_graph', 'callGraphSlice', strictObject({ functionIds: { ...functionIds, maxItems: 16 },
    resultLimit: boundInteger(1, 512), targetLimit: boundInteger(1, 64) }, ['functionIds']),
    'Read callsites in up to sixteen explicit canonical functions. Literal 64-bit targets bind only to selected, source-bound entries. Unresolved and ambiguous targets remain open. No recursive discovery, ABI inference, runtime calls or call-graph closure proof. Results may require continuation.'],
  ['resume_scoped_call_graph', 'resumeCallGraphSlice', cursor,
    'Consume one single-use, same-world call-graph continuation. Source references and cumulative budgets persist; cancelled/stale sessions cannot publish.'],
  ['list_range_value_ids', 'rangeValueCatalog', strictObject({ functionId: string, offset: boundInteger(0, 16384), limit: boundInteger(1, 256) }, ['functionId']),
    'List bounded canonical local value IDs and IR/SSA references for refine_value_facts. IDs are owner/snapshot-specific, not stable source variable names. Navigation only; no range proof.'],
  ['refine_value_facts', 'refineValueFacts', strictObject({ functionId: string, request: object, ownerIdentity: object }, ['functionId', 'request']),
    'Request bounded facts from the existing Phase8 SCCP/range owner. Does not create an alternate numeric evaluator or publish conditional facts globally. The native ARM64 route uses the existing isolated worker. Obtain numeric IDs with list_range_value_ids and pass its complete ownerIdentity unchanged; absent or changed identities are rejected. Other routes require a bound owner context.'],
  ['query_function_summaries', 'summarySlice', strictObject({ functionIds: { ...functionIds, maxItems: 32 } }, ['functionIds']),
    'Pin canonical local summaries incrementally, with continuation already during function loading, then compose them with the existing SCC solver. Unsettled SCCs are not exposed as exact returns; unknown external calls retain broad effects.'],
  ['resume_function_summaries', 'resumeSummarySlice', cursor,
    'Consume a time-limited same-world continuation covering source preparation and SCC solving with cumulative budgets. In-progress SCC state is private and is not semantic authority.'],
  ['export_evidence_slice', 'proofSlice', strictObject({ roots: { type: 'array', items: string, minItems: 1, maxItems: 128 }, includeBytes: { type: 'boolean' } }, ['roots']),
    'Export a bounded slice of the existing EvidenceGraph with optional bounded bytes. Provenance/content integrity is separate from semantic proof; missing premises and contradictory evidence remain visible.'],
  ['replay_evidence_slice', 'replayProof', object,
    'Recheck an exported same-world evidence slice against canonical nodes, current bytes and host-owned proof checkers. Serialized receipts, hashes, observations and AI confidence do not themselves prove semantics.'],
  ['cancel_scoped_query', 'cancelScopedQuery', cursor,
    'Release a retained scoped-query continuation. This only cancels local ephemeral work, never changes canonical facts or the binary.'],
];

export function installScopedAnalysisTools(registry, context) {
  if (context?.analysisAuthority !== 'AnalysisQueryAPI' || typeof context.runScopedAnalysis !== 'function') return registry;
  // Preflight every reserved name before mutating the registry. A conflict
  // near the end must not leave an apparently installed partial capability set.
  for (const [name] of definitions) {
    if (registry.get(name)) throw new TypeError(`scoped-tool-name-conflict:${name}`);
  }
  for (const [name, method, inputSchema, description] of definitions) {
    registry.register({ name, description: `${description} Native functionId inputs are current address locators (for example 0x1000), not canonical semantic entity IDs. Reuse reference.functionLocator or a result member locator. Optional workBudget sets finite per-invocation limits; session totals and expiry never reset.`, inputSchema: withWorkBudget(inputSchema), cost: method === 'scopedCapabilities' ? 'cheap' : 'expensive',
      scopeSupport: ['auto', 'binary', 'project'], mutability: 'read-only', needsApproval: false,
      // Session/cost envelopes are intentionally not replayed from the tool cache.
      // The canonical ArtifactStore remains free to reuse bound owner artifacts.
      deterministic: false, storeResult: true,
      execute: async (args, execution = {}) => {
        const input = snapshotContractData(args, { allowBigInt: true, maxBytes: method === 'replayProof' ? 8 * 1024 * 1024
          : method === 'replayReferenceSlice' ? 3 * 1024 * 1024 : 262144, maxNodes: 100000 });
        const { workBudget: requested, ...request } = input;
        const limits = requested === undefined ? undefined : normalizeQueryLimits(requested);
        return context.runScopedAnalysis(method, request, {
          signal: execution.signal ?? registry.executionSignal ?? null, ...(limits ? { limits } : {}),
        });
      },
    });
  }
  return registry;
}
