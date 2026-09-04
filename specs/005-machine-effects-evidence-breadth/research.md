# Research: MachineEffects Independent Evidence Breadth

## Decision 1: Extend the existing offline evidence owner

- **Decision**: Extend #2372 schema/runner/report; reuse the current A2 profile inventory and external-oracle policy.
- **Rationale**: This preserves one validation authority and keeps production MachineEffects as the subject.
- **Alternatives considered**: A second provider/framework was rejected as common-mode and governance duplication.

## Decision 2: Separate evidence availability from semantic completeness

- **Decision**: A pinned model identity can be available while an individual claim remains partial or unsupported.
- **Rationale**: Model presence does not establish covered observables or a complete outcome universe.
- **Alternatives considered**: Treating repository/version presence as exact proof was rejected.

## Decision 3: Pin official model and execution identities

- **Decision**: Record Isla `f189d5cbf6d732839879024c74ab0a8478bc1e28`, the Isla Arm v8.5 snapshot `d8b31014643035a3b11071e56ef30001de3f52ab`, Sail RISC-V `0.13.1` / `27224ccb2290f022e46213c05b3e72e8a9ea635e`, and herdtools7 `7.58` / `1ca343e16a2038e406d1ac674e7e3a1b722b36c7` as audited formal identities. Record the exact QEMU AArch64/RISC-V version and binary digest used for independent concrete execution in each generated manifest.
- **Rationale**: The formal inputs are official primary repositories/releases and are independently reproducible offline; QEMU provides a separately implemented concrete execution check without being treated as architectural proof.
- **Alternatives considered**: Floating branches, browser runtime embedding, and unversioned prose citations were rejected.

## Decision 4: First-class undefined-result contract

- **Decision**: Add a validated undefined-result descriptor to canonical operations and preserve it as Semantic IR V2 machine-effect attributes; consumers must fail closed.
- **Rationale**: Free-form metadata alone transports bytes but cannot enforce width/mask/class invariants or stop exact folding.
- **Alternatives considered**: Test-only metadata and downstream-only patches were rejected.

## Architecture evidence boundary

| Profile | Production support | Independent source | Phase 2 boundary |
|---|---|---|---|
| arm64:a64 | declared by A2 | Isla Arm v8.5 snapshot + herd AArch64 model + QEMU concrete execution | formal/ordering artifacts accepted only with complete observables |
| arm64e:a64+pac | declared by A2 | Arm profile reference; no complete PAC formal execution artifact | partial/unsupported remains explicit |
| x86_64:long-64 | declared by A2 | existing compiler truth; no complete modern x86 formal model | partial; no architecture-wide exact promotion |
| riscv64:rv64imc | declared by A2 | Sail RISC-V 0.13.1 + QEMU concrete execution | sequential evidence supported; relaxed-memory remains partial without generated outcome artifact |
