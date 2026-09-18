# X02-B-06 current acceptance — 2026-09-17

## Status

**Current overlay: `pass`.** The frozen 120-row historical matrix is intentionally unchanged: `X02-B-06` retains historical `expectedDisposition: evidence-gap` so the original denominator and audit history are not rewritten after the fact.

Requirement: **HEX-X-02 / FR-X-02A — real shared-cache slide-info and runtime load-map evidence.**

Whole-roadmap state is unchanged by this row-level acceptance: `CHECKPOINT-LOCKED`, `fullRoadmapComplete:false`, `transformAuthorization:false`.

## Evidence chain

Collector implementation commit: `6a9277931c423a7a3cc1a7e0749c3dae313222ed` (`test(x02): capture runtime dyld slide evidence`).

First successful real-Apple capture:

- GitHub Actions run: `35124890143`
- exact head: `6a9277931c423a7a3cc1a7e0749c3dae313222ed`
- artifact: `10459365113` / `x02-real-apple-acceptance-6a9277931c423a7a3cc1a7e0749c3dae313222ed`
- artifact digest: `sha256:60b5053acac0ae56ffc645165759fdadfab476c5795d7431eb8851dc629b4713`
- environment: macOS `15.7.9` build `24G830`, Apple Silicon `arm64`, Xcode `16.4`, Apple clang `17.0.0 (clang-1700.0.13.5)`

Pinned current-acceptance fixture:

- `tests/scpa/fixtures/x02-b06-runtime-dyld-evidence-20260916.json`
- fixture commit: `c6864e7e2cf0f3ac2505ac28428ae2265cd0120a`

Dedicated current-overlay acceptance test:

- `tests/scpa/x02-b06-runtime-dyld-evidence.test.mjs`
- test commit: `498c1bc418bb5d41e3393b6e587d688d62275d31`

Strict workflow validation commit: `dd7043e69ffdd2d24733190d35a5ed31efd4985e` (`ci(x02): require B06 runtime dyld provenance`).

Strict replay:

- GitHub Actions run: `35125384165`
- exact head: `dd7043e69ffdd2d24733190d35a5ed31efd4985e`
- `real-apple-evidence`: **success**
- finite X-02 lane including the dedicated B06 test: **success**
- real Apple collector: **success**
- strict B06 runtime validator: **success**
- replay artifact: `10459385724` / `x02-real-apple-acceptance-dd7043e69ffdd2d24733190d35a5ed31efd4985e`
- replay artifact digest: `sha256:8979838b71f044c52fe17fd38e254d1a95ebc37fb68f3a5acddbfb1e473baa18`

## Observed runtime provenance

Pinned real cache:

- path: `/System/Cryptexes/OS/System/Library/dyld/dyld_shared_cache_arm64e`
- SHA-256: `c88d3a9885614d4ee8be36f0e9a50ee09e640311ca0ea843bc67613933e00184`
- cache UUID: `0517ae4831dc30868d85545fef4d70b7`
- slide-info version: `5`
- unslid shared-region start: `0x180000000`
- shared-region size: `0x12c684000`

Observed process runtime map:

- runtime cache UUID: `0517ae4831dc30868d85545fef4d70b7` — matches the pinned on-disk cache UUID
- runtime cache start: `0x1980d8000`
- runtime cache size: `0x12c684000`
- OS-derived runtime slide: `0x180d8000`
- process images observed: `44`
- shared-cache images observed: `43`
- every recorded shared-cache image reports the same runtime slide

Production decoder proof:

- bounded pages: `[0, 677, 1314, 1955]`
- sampled v5 rebases: `6077`
- all unslid sampled targets are inside the declared shared region
- the production v5 decoder was rerun using the OS-observed runtime slide
- runtime decoded rebase count: `6077`
- each sampled runtime storage/target address equals its unslid address plus the observed slide
- all sampled runtime targets are inside the observed runtime shared-cache range

Therefore B06 no longer relies only on static cache metadata: the cache identity, process runtime load-map, OS-derived slide, loaded-image slides, and production-decoder runtime address derivation are tied into one captured evidence chain.

## Preserved boundaries

- This is a bounded real-cache sample, not an exhaustive walk of every rebase in the cache.
- It does not promote `X02-F-47`; explicit arm64e runtime authentication remains separately environment-scoped.
- It does not edit the frozen 120-row historical expectation or denominator.
- It does not by itself authorize the whole roadmap or release.

With the separately accepted A08 current overlay, the finite current overlay is now **118 pass / 0 product-gap / 0 evidence-gap / 2 environment-excluded** when the exact pinned LLVM 18.1.3 oracle is unavailable. If `X02-H-02` independently succeeds with the exact pinned LLVM executable/version/digest/format/architecture checks, the conditional classification is **119 / 0 / 0 / 1**. `X02-F-47` remains the other environment-excluded row.
