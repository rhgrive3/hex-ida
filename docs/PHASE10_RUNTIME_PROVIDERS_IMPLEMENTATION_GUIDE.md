# Runtime Providers Implementation Guide

> **Last Updated:** 2026-11-28  
> **Scope:** `js/runtime/`, `js/adapters/`, `js/debug/`, `js/runtime-evidence/`  
> **Normative Reference:** [`HEX_MASTER_ARCHITECTURE.md`](./HEX_MASTER_ARCHITECTURE.md)

## 1. Architecture Overview

The Runtime Provider plane unifies debugger, instrumentation, trace/replay, and emulator execution behind shared canonical identity, lifecycle, event, protocol, and evidence contracts without creating a second semantic truth system.

```text
Core Identity (BinaryId, SliceId, FunctionId, EvidenceId, RuntimeSessionId)
  ↓
RuntimeProviderPlatform / RuntimeProviderRegistry (js/runtime/provider-platform.js, provider-core.js)
  ├── DebuggerProvider        (js/runtime/debugger-provider.js)
  ├── InstrumentationProvider (js/runtime/instrumentation-provider.js)
  ├── TraceProvider           (js/runtime/trace-provider.js)
  └── EmulatorProvider        (js/runtime/emulator-provider.js)
  ↓
RuntimeEventNormalizer & RuntimeEvidenceBridge (js/runtime/events.js, evidence-bridge.js)
  ↓
RuntimeAnalysisPlatform & Static/Dynamic Fusion (js/runtime/index.js, js/runtime-evidence/)
```

## 2. Core Modules (`js/runtime/`)

| Module | Purpose | Key Exports |
| :--- | :--- | :--- |
| `js/runtime/index.js` | High-level runtime analysis orchestration, experiments, tracing, memory reads, cross-version replay | `RuntimeAnalysisPlatform`, `DebugSessionManager`, adapter & evidence re-exports |
| `js/runtime/provider-core.js` | First-class provider facets, session state machine, registry, legacy adapter wrapper | `RUNTIME_FACETS` (`debugger`, `instrumentation`, `trace`, `emulator`), `RUNTIME_SESSION_STATES`, `RuntimeProviderSession`, `RuntimeProviderRegistry`, `DebugAdapterRuntimeProvider`, `wrapDebugAdapterAsRuntimeProvider` |
| `js/runtime/provider.js` | Public provider facade | Re-exports `provider-core.js` and `createRuntimeOperationController` |
| `js/runtime/provider-platform.js` | Unified multi-facet provider platform | `RuntimeProviderPlatform` |
| `js/runtime/debugger-provider.js` | Debugger facet implementation | `DebuggerProvider`, `createDebuggerProvider` |
| `js/runtime/instrumentation-provider.js` | Instrumentation/hook facet implementation | `InstrumentationProvider`, `createInstrumentationProvider` |
| `js/runtime/trace-provider.js` | Immutable trace/replay facet implementation | `TraceProvider`, `createTraceProvider` |
| `js/runtime/emulator-provider.js` | Backend-neutral emulator facet implementation | `EmulatorProvider`, `createEmulatorProvider` |
| `js/runtime/provider-identity.js` | Session-scoped target, module generation, and address resolution bindings | `createRuntimeProviderSessionId`, `createRuntimeTargetBinding`, `RuntimeModuleBindingTable`, `createRuntimeAddressResolution`, `RUNTIME_RESOLUTION_STATES` |
| `js/runtime/module-binding.js` | Runtime-to-static module identity verification | `hasProvenRuntimeStaticIdentity`, `normalizeRuntimeModuleBinding` |
| `js/runtime/authority.js` | Runtime authority & observation schemas (`hex-runtime-authority/v1`, `hex-runtime-observation/v1`) | `createRuntimeAuthorityBinding`, `createRuntimeObservation`, `validateRuntimeObservation`, `RuntimeAuthorityTracker`, `runtimeProfileSupport` |
| `js/runtime/events.js` | Canonical runtime event envelope and normalizer | `RUNTIME_OBSERVATION_MODES` (`observed`, `intervened`, `synthetic`), `RUNTIME_EVENT_KINDS`, `createRuntimeEvent`, `normalizeLegacyRuntimeEvent`, `createRuntimeEventBatch`, `RuntimeEventNormalizer` |
| `js/runtime/evidence-bridge.js` | Bridge from runtime events/interventions to canonical Evidence | `RuntimeEvidenceBridge`, `InterventionLedger`, `createInterventionRecord`, `conservativeCompleteness`, `RUNTIME_EVIDENCE_RELATIONS` |
| `js/runtime/provider-protocol.js` | Hardened provider wire protocol (`hex-runtime-provider` v1) | `RUNTIME_PROVIDER_PROTOCOL`, `RUNTIME_PROVIDER_PROTOCOL_VERSION`, `validateProviderPacket`, `createProviderHello`, `negotiateProviderHello`, `RuntimeProviderProtocolClient` |
| `js/runtime/session.js` | Epoch-guarded debug session lifecycle | `DebugSession`, `DebugSessionManager` |
| `js/runtime/operation-controller.js` | AbortSignal and epoch-bound operation fencing | `createRuntimeOperationController` |
| `js/runtime/memory.js` | Bounded sandbox/runtime memory map | `RuntimeMemoryMap`, `MemoryRegion`, `createSandboxMemoryMap`, `RUNTIME_HEAP_BASE`, `RUNTIME_HEAP_SIZE` (4 MiB), `MAX_SANDBOX_REGIONS` (65,536) |
| `js/runtime/scoped-experiment-broker.js` | Host-only scoped experiment authorization broker | `ScopedExperimentBroker` |
| `js/runtime/scoped-reconciliation.js` | Static/runtime call-target reconciliation (`scoped-runtime-reconciliation/v1`) | `queryRuntimeReconciliation`, `scopedStaticAddress`, `scopedCallTargetDomain` |
| `js/runtime/app-runtime.js`, `stage2.js`, `native-scoped-context.js`, `captured-async.js` | Application wiring, Stage 2 authority facade, native scoped context, and async event capture | `bindRuntimeProviderPlatformForApp`, `runtimePlatformForApp`, `createNativeScopedRuntimeContextProvider`, `bindCapturedAsyncEvents` |

## 3. Key Invariants

- **Canonical Identity vs. Session Bindings**: Core IDs (`BinaryId`, `SliceId`, `FunctionId`, `EvidenceId`, `RuntimeSessionId`) remain canonical. Live process/module/thread instances use session-scoped bindings (`RuntimeModuleBindingTable`, `createRuntimeAddressResolution`) with explicit module generations; a runtime virtual address never implies a static `FunctionId` without proven module binding.
- **Session Lifecycle & Epoch Fencing**: Sessions transition across `opening`, `ready`, `running`, `paused`, `degraded`, `disconnected`, `closing`, `closed`, `failed`. Every async trace, read, and experiment is fenced by session epoch, `AbortSignal`, and finite wall-time deadlines; late or cross-epoch results are rejected and never publish evidence.
- **Observation Mode Separation**: Events and evidence explicitly distinguish `observed` (live passive), `intervened` (instrumented/mutated, tracked via `InterventionLedger`), and `synthetic` (emulated/sandboxed).
- **Cross-Version Replay Safety**: `RuntimeAnalysisPlatform.replayExperiment()` refuses unverified binary mismatches unless `resolveFunction` returns an explicitly accepted, unambiguous match (`confidence >= 0.85`, `ambiguityMargin >= 0.10`).
- **One Experiment per Session & Host Publication Guard**: `runExperiment()` serializes execution per session and supports an in-process host `publicationGuard` callback (used by `ScopedExperimentBroker`).

## 4. Verification Commands

```bash
npm run phase10:test
npm run phase10:verify
npm run runtime:test
```
