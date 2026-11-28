# Managed Frontends Implementation Guide (WASM, DEX, CIL, JVM)

> **Last Updated:** 2026-11-28  
> **Scope:** `js/managed/`  
> **Normative Reference:** [`HEX_MASTER_ARCHITECTURE.md`](./HEX_MASTER_ARCHITECTURE.md), `js/platform/capability-maturity.js`

## 1. Architecture Overview

Hex implements four first-class managed bytecode frontends—**WASM**, **DEX**, **CLR/CIL**, and **JVM**—through a single `VMEffects`-to-shared-Semantic-IR pipeline:

```text
Container / Bytecode Bytes
  ↓  probeManagedFrontend / openManagedImage (js/managed/index.js)
Frontend (WasmFrontend | DexFrontend | CilFrontend | JvmFrontend)
  ↓  Parser + Validator / Verifier + Lifter
VMEffects (VM_EFFECTS_SCHEMA_VERSION = 1, VM_EFFECTS_CONTRACT_VERSION = 1.0.0)
  ↓  lowerVMEffectsToSemanticIr (js/managed/shared/bridge-v2.js)
Shared Semantic IR → CFG / SSA → TypeConstraintGraph / Interprocedural Summaries → Decompiler
```

### Current Capability Maturity (`js/platform/capability-maturity.js`)

| Frontend | ID | Implemented / Satisfied Level | Supported Features | Unsupported / Deferred |
| :--- | :--- | :--- | :--- | :--- |
| WebAssembly | `wasm` | `M5` / `M5` (`partial` overall) | `detectContainer` (M0), `metadata` (M1), `vmEffects` (M2), `cfgSsa` (M3), `typesInterprocedural` (M4), `decompiler` (M5) | `runtimeDebug` (M6) |
| Dalvik / Android DEX | `dex` | `M5` / `M5` (`partial` overall) | M0–M5 (`detectContainer` through `decompiler`) | `runtimeDebug` (M6) |
| .NET CLR / CIL | `cil` | `M5` / `M5` (`partial` overall) | M0–M5 (`detectContainer` through `decompiler`) | `runtimeDebug` (M6) |
| Java Bytecode / JVM | `jvm` | `M5` / `M5` (`partial` overall) | M0–M5 (`detectContainer` through `decompiler`) | `runtimeDebug` (M6) |

## 2. Shared Contracts (`js/managed/shared/` & `js/managed/runtime-binding.js`)

- **Entrypoint (`js/managed/index.js`)**: Exports `MANAGED_FRONTENDS` (`{ wasm, dex, cil, jvm }`), `probeManagedFrontend(bytes, options)`, and `openManagedImage(bytes, options)`.
- **Canonical Managed Identity (`shared/identity.js`)**: `createManagedImageId`, `createManagedModuleId`, `createManagedTypeId`, `createManagedMethodId`, `createManagedFieldId`, `createVMOperationId`, `createVMValueId`, `createVMFrameStateId`, `createManagedCallSiteId`, `createManagedExceptionRegionId`, `createManagedTargetProfileId`.
- **Target Profile (`shared/profile.js`)**: `MANAGED_FRONTEND_IDS = ['wasm', 'dex', 'cil', 'jvm']`, `createManagedTargetProfile`, `validateManagedTargetProfile`. Exact semantics are always bound to a concrete target profile (format version, VM spec edition, feature set, validation policy).
- **VMEffects Contract (`shared/vm-effects.js`)**: Sibling to native `MachineEffects` (`VM_EFFECTS_SCHEMA_VERSION = 1`, `VM_EFFECTS_CONTRACT_VERSION = '1.0.0'`). Enforces explicit completeness (`VM_EFFECT_COMPLETENESS`), unknown categories (`VM_UNKNOWN_CATEGORIES`), operation/location kinds, budget tracking (`createVMEffectBudgetTracker`), and immutable validated bundles (`createVMEffectBundle`, `createVMEffectFunction`).
- **Validation Reports (`shared/validation.js`)**: `MANAGED_VALIDATION_STATUS = ['valid', 'invalid', 'partial', 'unsupported']`. Invalid bytecode remains inspectable without silently repairing invalid stack or register state.
- **Shared Bridge (`shared/bridge-v2.js`, `MANAGED_BRIDGE_VERSION = '1.0.0'`)**:
  - `lowerVMEffectsToSemanticIr` (with target-specific lowering overlays: `bridge-dex-overlay-v2.js`, `bridge-jvm-{control,local,object}-overlay-v2.js`, `bridge-wasm-{narrow-load,select}-overlay-v2.js`, `bridge-shift-count-overlay-v2.js`)
  - `buildManagedTypeConstraintGraph`, `buildManagedMethodSummary`, `analyzeManagedInterprocedural`, `decompileManagedMethod`
  - `queryManagedSymbolicVerification`, `queryManagedRuntimeProvider`
- **Managed Runtime Binding (`js/managed/runtime-binding.js`)**: `MANAGED_RUNTIME_BINDING_SCHEMA = 'hex-managed-runtime-binding/v1'`, `createManagedRuntimeBinding`, `validateManagedRuntimeState`, `validateManagedRuntimeObservation`, `managedRuntimeProfileSupport`.

## 3. Frontend Modules

| Frontend | Directory | Core Components |
| :--- | :--- | :--- |
| **WASM** | `js/managed/wasm/` | `frontend.js` (`WasmFrontend`), `parser.js` / `parser-core.js`, `module-index.js`, `validator.js`, `memory-validation.js`, `lifter.js` / `lifter-core.js` |
| **DEX** | `js/managed/dex/` | `frontend.js` (`DexFrontend`), `parser.js`, `leb128.js`, `integrity.js`, `map-validation.js`, `descriptor.js`, `method-definitions.js`, `exception-table.js`, `control-flow.js`, `register-dataflow.js`, `field-effects.js`, `array-type-effects.js`, `validation*.js`, `lifter*.js` |
| **CIL** | `js/managed/cil/` | `frontend.js` (`CilFrontend`), `cli-header.js`, `parser*.js`, `metadata-{budget,context,definitions,definitions-core,generics,layout,manifest-security,streams,string-cache}.js`, `call-signature*.js`, `custom-attribute-values.js`, `stack-width.js`, `validation.js`, `lifter*.js` |
| **JVM** | `js/managed/jvm/` | `frontend.js` (`JvmFrontend`), `parser.js` / `parser-core.js`, `verifier.js`, `descriptors.js`, `value-type.js`, `{class,field,method}-flags.js`, `{field,method}-reference.js`, `object-semantics.js`, `array-semantics.js`, `lifter*.js` |

## 4. Non-Negotiable Invariants

- **`VMEffects` is not fake `MachineEffects`**: Each VM's native state model (WASM typed stack/structured control, DEX register file, CIL typed evaluation stack + metadata tokens, JVM operand stack + verification types) is preserved before lowering.
- **One downstream truth**: Frontends do not own private CFGs, SSAs, or decompilers; shared analysis consumes lowered Semantic IR.
- **Inspectable invalid inputs**: Malformed or obfuscated bytecode surfaces explicit `invalid` / `partial` validation status instead of silent repair.
- **Bounded admission**: Both `probe()` and `open()` enforce resource budgets and fail closed on malformed or over-budget metadata.

## 5. Verification Commands

```bash
npm run phase11:test
npm run phase11:verify
```
