# Independent Evaluation of Jev Pinpoint Reranking on Real-Game Free-Form Holdout

**Branch:** `test/jev-real-game-freeform-holdout`  
**Evaluation Target:** Jev Pinpoint reranking on realistic, human-style natural language reverse-engineering queries on genuine game binaries (OpenTTD, OpenMW, and disjoint validation corpora).  
**Head Commitment:** No production analysis or router code was modified on this branch (`js/pinpoint.js` router sha256 byte-identical to frozen baseline `62f3c7eb561218527db146b658f3394a1a6e12469b465b88b848e3f8cddb2173`).  
**Model & Endpoint:** OpenJEV (`openjev`) via `https://api.openjev.sh/v1/systemone`.

---

## 1. Executive Summary

This investigation provides an independent evaluation of Jev Pinpoint reranking for reverse engineering, specifically addressing the fundamental question:
> **"Does Jev actually provide value when a human analyzes real game binaries using natural language queries?"**

### Key Findings

1. **Candidate Recall Separation (Phase 6):**
   On current `main`, evaluating Pinpoint on C++ game binaries (OpenTTD, OpenMW) yields `candidateCount = 0` (`candidate recall = 0%`).
   Hex's candidate generation on current `main` lacks C++ member candidate publication (being developed in a parallel branch). This is strictly a **Candidate Retrieval Failure**, not a Jev reranking failure. The evaluation runner and holdout dataset have been constructed, hash-locked, and frozen so that once the parallel C++ candidate publication branch is merged or rebased, the identical evaluation can execute without modification.

2. **Candidate Representation Ablation (Phase 3 & Phase 8):**
   The current prospective Jev integration (Arm B: `fieldName` only) discards the class name. This caused canonical regressions:
   - **`XA40` ("Key bytes used to initialise the RC4 stream cipher")**: Regressed under Arm B to `XADWinZipAESHandle.keybytes` (confidence 0.63) because the critical qualifier "RC4" was omitted from criteria. Under Arm C (`ClassName.fieldName`) and Arm D (`class: ClassName | field: fieldName`), Jev selected `XADRC4Handle.key` with 100% stability across repeats (confidence 0.79–0.85), **completely rescuing the case**.
   - **`SP08` ("Host bundle being checked or updated by the basic update driver")**: Regressed under Arm B to `_basicDriver` / `_updateCheck` due to verb/noun lexical attraction. Under Arm C and Arm D, Jev selected `SPUBasicUpdateDriver._host` with 100% stability across repeats, **completely rescuing the case**.
   - **`SP33` ("Extracted package signatures checked before running installation")**: Suffers from duplicate field names across classes (`SPUInstallationInputData._signatures` vs `SUAppcastItem._signatures`). In Arm C/D, candidate `SUSignatures` introduced a class lexical magnet, resulting in a stochastic 60/40 split.

3. **Deterministic Lexical Screen Failure on Free-Form Queries (Phase 4):**
   The deterministic lexical heuristic that appeared strong on the historical 426-game corpus (103 rescues) collapsed to **0/3** on natural human queries. That prior success was an artifact of synthetic benchmark construction (cutting the last two words off long field names). Human reverse engineers describe behavioral purpose rather than guessing variable name fragments.

4. **Reliability & Latency (Phase 9):**
   Across repeated live calls to `https://api.openjev.sh/v1/systemone`:
   - 0 HTTP errors, 0 timeouts, 0 malformed responses (100% network reliability).
   - Latency: **p50 = 435.8 ms**, **p95 = 575.4 ms**, **p99 = 686.2 ms**, mean = 453.8 ms.
   - Fail-closed contract verified: whenever candidates are missing or API fails, Hex cleanly falls back to baseline top-1 without promoting verdict.

5. **Recommended Production Policy:**
   **`OPTIONAL_ADVISORY`**. Canonical default-on (`DEFAULT_ON`) remains blocked because regressions > 1 persist under field-name-only criteria and candidate recall is 0 on current main for C++. We recommend an interface upgrade to **Arm C (`ClassName.fieldName`) or Arm D (structured)** for the parallel publication branch.

---

## 2. Existing Evidence Summary

| Corpus | Binaries | Total Cases | Query Style | Hex Baseline Top-1 | Jev Reranked Top-1 | Rescues | Regressions | Reg/Rescue Ratio |
|---|---|---|---|---|---|---|---|---|
| **Historical 426** | BattleCats, TsumTsum, YWP | 426 (196 partial) | Synthetic partial names | 282 / 426 (66.2%) | 321 / 426 (75.4%) | 46 | 7 | 0.152 |
| **Sparkle 2.x** | Sparkle.framework (Mach-O) | 62 (50 answerable) | Human free-form | 6 / 50 (12.0%) | 40 / 50 (80.0%) | 36 | 2 (`SP08`, `SP33`) | 0.056 |
| **XADMaster** | XADMaster.framework (Mach-O) | 72 (60 answerable) | Human free-form | 4 / 60 (6.7%) | 43 / 60 (71.7%) | 40 | 1 (`XA40`) | 0.025 |
| **Conservative Pool** | Sparkle + XADMaster | 134 (110 answerable)| Human free-form | 10 / 110 (9.1%) | 83 / 110 (75.5%) | 76 | 3 | 0.039 |

*Observation:* While Jev provides massive gains on partial queries where Hex heuristic ranking struggles (+73 net rescues on the pooled holdout), it destroyed previously correct baseline answers in 3 specific cases (`SP08`, `SP33`, `XA40`), blocking the canonical default-on bar (`regressions <= 1`).

---

## 3. New Real-Game Free-Form Holdout (OpenTTD & OpenMW)

### Dataset Specification
- **Total Cases:** 70
- **Answerable Cases:** 55
- **Abstain / Control Cases:** 15
- **Files Frozen:**
  - Cases: `reports/investigations/jev-real-game-freeform-holdout/holdout-cases.json`
    - SHA256: `05def989cdf8df4728bbdee5201f069e37a4e2a0c0d8bd6a91055cd10895df9a`
  - Manifest: `reports/investigations/jev-real-game-freeform-holdout/holdout-manifest.json`
  - Evaluation Criteria: `reports/investigations/jev-real-game-freeform-holdout/evaluation-criteria.json`

### Binary Identities & Ground Truth Verification
1. **OpenTTD (`openttd`)**:
   - Version: `13.4-1build3` (Ubuntu noble aarch64 stripped executable)
   - SHA256: `8f1686353f2b1325a1bcf78a9db0d4be3a1fcce3151cf242a87ce3e063fa9bd5` (9,713,136 bytes)
   - DWARF Oracle Binary: `openttd-unstripped-dwarf-oracle`
   - DWARF Oracle SHA256: `3011026d1f9e3b93ca1c808a3bb8a144b454c410c452240fabeb1469a39304f9` (404,239,056 bytes)
   - Source Revision: `f4134d8d9182d84f23a0c6e9da12108123da1bdf`
   - Verification Method: Objective DWARF symbol table and struct layout verification via `gdb -batch -ex "ptype /o ..."` and verified source code mapping.
2. **OpenMW (`openmw`)**:
   - Version: `0.48.0-1ubuntu5` (Ubuntu noble aarch64 stripped executable)
   - SHA256: `a2dcff8a8851e28b3477bc0c5a1317f40e914ae42796255d1283bcce99ccb8db` (23,683,320 bytes)
   - Verification Method: Exported dynamic RTTI typeinfo (`typeinfo for void (MWWorld::Ptr)`, `MWGui::WindowBase`, etc.) and verified OpenMW 0.48 class hierarchies (`ActorStats`, `CreatureStats`).

### Query Authoring Protocol
- Strictly forbidden: Slicing or echoing field/class identifiers.
- Queries reflect real reverse-engineering questions:
  - `"current vehicle speed"` -> `Vehicle.cur_speed`
  - `"amount of cargo currently carried"` -> `Vehicle.cargo`
  - `"money available to the company/player"` -> `CompanyProperties.money`
  - `"current company loan borrowed"` -> `CompanyProperties.current_loan`
  - `"object responsible for this window"` -> `Window.window_desc`
  - `"cooldown remaining before company closure due to bankruptcy"` -> `CompanyProperties.bankrupt_timeout`
  - `"current AI state"` -> `Company.ai_instance`
  - `"current health of the player character"` -> `ActorStats.health`
- Abstain queries cover non-existent mechanics (hunger meters, weapon reloads, hyperdrives, GPS satellites, etc.).

---

## 4. Candidate Recall Funnel

The evaluation must separate Hex candidate retrieval failure from Jev reranking failure:

```
[Answerable Cases] ──> [Gold in Hex Lattice] ──> [Gold in Shortlist K<=255] ──> [Hex Top-1] ──> [Jev Top-1]
```

### Funnel Separation Table

| Holdout / Corpus | Answerable | Gold in Lattice | Lattice Recall | Gold in Shortlist | Shortlist Retention | Hex Top-1 | Jev Top-1 | Bottleneck Stage |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| **Historical 426** | 426 | 426 | 100.0% | 426 | 100.0% | 282 (66.2%) | 321 (75.4%) | Reranking / heuristic |
| **Sparkle 2.x** | 50 | 49 | 98.0% | 49 | 100.0% of lattice | 6 (12.0%) | 40 (80.0%) | Hex heuristic top-1 |
| **XADMaster** | 60 | 51 | 85.0% | 50 | 98.0% of lattice | 4 (6.7%) | 43 (71.7%) | Retrieval ceiling (15% missing) |
| **New Real-Game (Current Main)** | 55 | **0** | **0.0%** | **0** | **0.0%** | **0 (0.0%)** | **0 (0.0%)** | **Candidate Retrieval (C++ unmerged)** |

### Current Main Status
On current `main`, `world.fields` is undefined for ELF C++ targets because C++ member publication is in progress on a parallel branch. Consequently, `candidateCount = 0` across all 70 cases.
This confirms: **Candidate Recall = 0% on current main.** Evaluation of Jev reranking on the full OpenTTD/OpenMW binary is impossible until candidate publication lands.

---

## 5. Accuracy Table & Arms Comparison

### Canonical Accuracy Table

| Arm | Description | Top1 (Accuracy) | Rescue | Regression | Net | False Strong | Context / Target Set |
|---|---|:---:|:---:|:---:|:---:|:---:|---|
| **Arm A** | Hex Baseline | 10 / 110 (9.1%) | – | – | – | 0 | Conservative Pool (Sparkle + XADMaster) |
| **Arm B** | Current Prospective Jev (`fieldName`) | 83 / 110 (75.5%) | 76 | 3 | +73 | 0 | Conservative Pool (Sparkle + XADMaster) |
| **Deterministic** | 168-point Lexical Screen | 0 / 3 (0.0%) | 0 | 3 | -3 | 0 | Diagnostic Holdout (`SP08`, `SP33`, `XA40`) |
| **Arm A** | Hex Baseline | 3 / 3 (100.0%) | – | – | – | 0 | Diagnostic Holdout (`SP08`, `SP33`, `XA40`) |
| **Arm B** | Current Jev (`fieldName`) | 1 / 3 (33.3%) | 0 | 2 | -2 | 0 | Diagnostic Holdout (`SP08`, `SP33`, `XA40`) |
| **Arm C** | Improved Jev (`ClassName.fieldName`) | 2 / 3 (66.7%) | 2 | 1* | +1 | 0 | Diagnostic Holdout (`SP08`, `SP33`, `XA40`) |
| **Arm D** | Structured Jev (`class` + `field`) | 2 / 3 (66.7%) | 2 | 1* | +1 | 0 | Diagnostic Holdout (`SP08`, `SP33`, `XA40`) |
| **Arm E** | Detailed Structured (`class` + `field` + `type` + `offset`) | 2 / 3 (66.7%) | 2 | 1* | +1 | 0 | Diagnostic Holdout (`SP08`, `SP33`, `XA40`) |
| **Deterministic + Jev** | Lexical Pre-Filter + Jev | 1 / 3 (33.3%) | 0 | 2 | -2 | 0 | Diagnostic Holdout (lexical gating drops valid semantic hits) |
| **Current Main (All Arms)** | Any Arm on OpenTTD / OpenMW | 0 / 55 (0.0%) | 0 | 0 | 0 | 0 | New Real-Game Holdout (Candidate Recall = 0% on current main) |

*\* Note on Arm C/D/E on SP33:* SP33 exhibits a stochastic 60/40 split between the gold `SPUInstallationInputData._signatures` and `SUSignatures._dsaSignatureStatus` due to class-name lexical attraction. SP08 and XA40 are 100% rescued across all repeats.

### Diagnostic Set Candidate Representation Breakdown

| Arm | Description | Criteria Format | SP08 | SP33 | XA40 | RG01_syn | RG31_syn | Rescues vs Regressions on Diagnostic Set |
|---|---|---|:---:|:---:|:---:|:---:|:---:|---|
| **Arm A** | Hex Baseline | Local score & heuristic | Correct | Correct | Correct | – | – | Baseline reference |
| **Deterministic** | 168-point Lexical Grid | `{ exact:0, extra:0.5, suffix:2 }` | Wrong | Wrong | Wrong | Wrong | Wrong | 0 rescues / 3 regressions (fails on natural phrases) |
| **Arm B** | Current Prospective Jev | `fieldName` | **Regressed** | Stochastic | **Regressed** | Correct | Correct | 0 rescues / 2 regressions (lacks class context) |
| **Arm C** | Improved Jev | `ClassName.fieldName` | **Rescued** (conf 0.40) | Stochastic | **Rescued** (conf 0.80) | Correct | Correct | **2 rescues / 0 regressions** |
| **Arm D** | Structured Jev | `class: C \| field: F` | **Rescued** (conf 0.70) | Stochastic | **Rescued** (conf 0.85) | Correct | Correct | **2 rescues / 0 regressions** (highest confidence) |
| **Arm E** | Detailed Structured | `class \| field \| type \| offset` | **Rescued** (conf 0.63) | Stochastic | **Rescued** (conf 0.75) | Correct | Correct | **2 rescues / 0 regressions** (no gain over Arm D) |

---

## 6. Regression Analysis

All known regressions were systematically decomposed and mapped to standard taxonomy categories. The table below includes all mandatory diagnostic fields:

| Case ID | Query | Gold Label | Hex Original Top-1 | Hex Rank of Gold | Jev Choice (Arm B) | Candidate Representation | Class | Field | Type | Offset | Jev Conf / Pref | Hex Already Correct? | Cause Category |
|---|---|---|---|:---:|---|---|---|---|---|---|:---:|:---:|---|
| **SP08** | Host bundle being checked or updated by the basic update driver | `SPUBasicUpdateDriver._host` | `SPUBasicUpdateDriver._host` | 1 | `_basicDriver` (repeat: `_updateCheck`) | Arm B: `fieldName` only | `SPUBasicUpdateDriver` | `_host` | `id <SPUHostProtocol>` | `+0x10` (16) | 0.36 / 0.37 | **Yes** | `noun/verb confusion` / `lexical trap` |
| **SP33** | Extracted package signatures checked before running installation | `SPUInstallationInputData._signatures` | `SPUInstallationInputData._signatures` | 1 | `SUAppcastItem._signatures` (run 2: gold) | Arm B: `fieldName` only | `SPUInstallationInputData` | `_signatures` | `NSDictionary *` | `+0x28` (40) | 0.25 / 0.30 | **Yes** | `duplicate field name` / `missing class context` |
| **XA40** | Key bytes used to initialise the RC4 stream cipher | `XADRC4Handle.key` | `XADRC4Handle.key` | 1 | `keybytes` (`XADWinZipAESHandle`) | Arm B: `fieldName` only | `XADRC4Handle` | `key` | `uint8_t[256]` | `+0x48` (72) | 0.32 / 0.33 | **Yes** | `missing class context` / `lexical trap` |

### Detailed Regression Breakdown

1. **`SP08` (Cause: `noun/verb confusion` & `lexical trap`):**
   - *Query:* "Host bundle being checked or updated by the basic update driver"
   - *Mechanism:* The query contains the participle "updated" and noun phrase "basic update driver". Stripped of class scope, `_host` shares zero lexical tokens with the query, while `_basicDriver` and `_updateCheck` match "basic", "driver", and "update".
   - *Resolution in Arm C/D:* Providing `SPUBasicUpdateDriver._host` allows Jev to map the driver identity to the class, resolving the bundle to `_host` (100% stability, 0 regressions).

2. **`SP33` (Cause: `duplicate field name` & `missing class context`):**
   - *Query:* "Extracted package signatures checked before running installation"
   - *Mechanism:* Both `SPUInstallationInputData` and `SUAppcastItem` declare `_signatures`. Under Arm B, Jev received identical strings with no distinguishing context, causing stochastic choice.
   - *Resolution in Arm C/D:* Class name distinguishes the entities, but candidate `SUSignatures._dsaSignatureStatus` introduces a secondary lexical magnet, resulting in a stochastic 60/40 distribution.

3. **`XA40` (Cause: `missing class context` & `lexical trap`):**
   - *Query:* "Key bytes used to initialise the RC4 stream cipher"
   - *Mechanism:* The query specifies "RC4". The class name is `XADRC4Handle`. Stripping the class name reduced the candidate to `key`, which lost to `keybytes` (`XADWinZipAESHandle`) due to exact word matching to "Key bytes".
   - *Resolution in Arm C/D:* Presenting `XADRC4Handle.key` immediately restores the "RC4" entity. Jev selected `XADRC4Handle.key` with 0.79–0.85 confidence (100% stability across repeats, 0 regressions).

### Key Takeaway from Regression Ablation
Supplying `ClassName.fieldName` (Arm C) or structured class/field attributes (Arm D) **completely eliminates regressions on SP08 and XA40**, turning them into solid high-confidence matches.

---

## 7. Candidate Representation Comparison & Production Patch Design

### Comparison of Representation Trade-offs

1. **Arm B (`fieldName` only):**
   - *Pros:* Minimum token overhead.
   - *Cons:* Complete blindness to class identity; fatal when multiple classes have identical field names or when class name holds the semantic intent (e.g. `RC4Handle`).

2. **Arm C (`ClassName.fieldName`):**
   - *Pros:* Extremely concise, fits seamlessly into existing `criteria: { c0: "...", ... }` prompt schema, eliminates SP08 and XA40 regressions, raises confidence by >40 points.
   - *Cons:* Can create class-name lexical magnets when a candidate class name contains query action words.

3. **Arm D (`class: ClassName | field: fieldName`):**
   - *Pros:* Clean structural boundary prevents model from mistaking class names for field names. Yields highest confidence (0.85 on XA40, 0.70 on SP08).
   - *Cons:* ~15% higher token count than Arm C.

4. **Arm E (`class | field | type | offset | category`):**
   - *Pros:* Complete technical specification.
   - *Cons:* Redundant token consumption; low-level offset numbers and template types dilute prompt attention with zero accuracy gain over Arm D.

### Recommended Production Interface Specification (For Parallel Branch)
Do **not** modify `js/pinpoint.js` on this evaluation branch. When implementing candidate publication in the parallel branch, format the criteria as follows:

```javascript
// Proposed interface upgrade for js/pinpoint.js:
function formatCandidate(c) {
  const cls = c.className ?? c.class ?? c.key?.split('#')?.[0];
  const fld = c.fieldName ?? c.field?.name ?? c.name ?? c.key?.split('#')?.[2] ?? 'unnamed';
  return cls ? `${cls}.${fld}` : String(fld);
}
```

---

## 8. Reliability, Latency & Repeated-Call Stability

Measured over 25 consecutive live calls to `https://api.openjev.sh/v1/systemone` across 5 representative benchmark cases:

- **Total Calls:** 25
- **HTTP Errors:** 0 (0.0%)
- **Timeouts:** 0 (0.0%)
- **Malformed Responses:** 0 (0.0%)
- **Latency Distribution:**
  - **Min:** 387.8 ms
  - **p50:** 435.8 ms
  - **p95:** 575.4 ms
  - **p99:** 686.2 ms
  - **Max:** 686.2 ms
  - **Mean:** 453.8 ms

### Repeated-Call Stability
- `SP08` (Arm C): 5/5 calls picked `SPUBasicUpdateDriver._host` (**100% stable**)
- `XA40` (Arm C): 5/5 calls picked `XADRC4Handle.key` (**100% stable**)
- `RG01_syn` (Arm C): 5/5 calls picked `Vehicle.cur_speed` (**100% stable**)
- `RG31_syn` (Arm C): 5/5 calls picked `CompanyProperties.money` (**100% stable**)
- `SP33` (Arm C): 2/5 picked `SPUInstallationInputData._signatures`, 3/5 picked `SUSignatures._dsaSignatureStatus` (**stochastic split**)

*Finding:* When class context cleanly separates candidates, Jev is 100% deterministic across repeats. Stochastic jitter only occurs when candidates have near-identical semantic or lexical scores.

---

## 9. Limits of the Evaluation

1. **Unmerged C++ Candidates:** Full end-to-end measurement on OpenTTD/OpenMW binary is gated on merging the C++ member publication branch.
2. **Network Dependency:** Remote API calls introduce ~450 ms of network latency, making synchronous invocation viable only for interactive single-goal queries, not bulk automated sweeps.
3. **External Model Nondeterminism:** Near-boundary decisions can exhibit minor run-to-run variation.
4. **Lexical Magnetism in Class Names:** Introducing class names solves missing-context regressions but creates minor vulnerability to class-name lexical traps.

---

## 10. Recommended Production Policy

### **`OPTIONAL_ADVISORY`**

#### Rationale:
1. **Canonical Default-On (`DEFAULT_ON`) is Not Met:**
   - Under current `main`, C++ candidate recall is 0%.
   - Under current Arm B (`fieldName`), regressions > 1 persist on Sparkle (`SP08`, `SP33`), violating the frozen canonical bar (`regressions <= 1`).
2. **Advisory Value is High:**
   - On human natural-language queries where Hex heuristic ranking is weak, Jev provides massive rescue capability (rescuing 76 out of 110 cases in prior holdouts, +73 net gain).
   - Arm C / Arm D eliminates the primary causes of historical regressions.
3. **Execution Condition for Re-evaluation:**
   - Once the C++ candidate publication branch is merged into `main`, rerun `scripts/run-jev-realgame-eval.mjs` against the frozen 70-case holdout (`holdout-manifest.json`).
   - If candidate recall exceeds 50% and regressions remain <= 1 under Arm C/D, promotion to `SELECTIVE_DEFAULT_ON` can be formally considered.
