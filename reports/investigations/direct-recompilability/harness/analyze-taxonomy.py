#!/usr/bin/env python3
"""Stage 2 analyzer: build diagnostic-taxonomy.json.

Every diagnostic across all 160 cases is assigned to exactly one cluster by a
deterministic matcher. Clusters are organised by the producer/emitter contract
that is responsible for the offending token, not by surface token spelling
alone.

Category A = translation-unit packaging / declaration completeness
Category B = decompiler function-body emission defect
Category C = ambiguous / mixed
Category D = environment or toolchain only
"""

import argparse
import collections
import glob
import json
import os
import re
import sys

HARNESS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HARNESS_DIR)
from identifier_taxonomy import classify_identifier  # noqa: E402

# ---------------------------------------------------------------------------
# Cluster registry: id -> metadata
# ---------------------------------------------------------------------------

C = {}

def add(cid, title, bucket, pve, producer, confidence, description,
        independent=True, cascade_of=None):
    C[cid] = {
        "id": cid,
        "title": title,
        "bucket": bucket,
        "packagingVsEmitter": pve,
        "producerLayer": producer,
        "confidence": confidence,
        "description": description,
        "independentDefect": independent,
        "cascadeOf": cascade_of,
    }


# --- Category A: translation-unit packaging ---------------------------------
add(
    "A-RUNTIME-HELPER-DECL",
    "undeclared decompiler runtime / pseudo-intrinsic helper",
    "A", "packaging",
    "call rendering + pseudo-intrinsic/runtime declaration contract",
    "high",
    "The printer emits helper calls (unknown_call, phi, bit_extract, bit_insert, "
    "sext, __a64_movi_*, __arm64_condition_*, __arm64_nzcv_*) as if a runtime "
    "header declared them. No such declaration is emitted in the TU.",
)
add(
    "A-GLOBAL-DATA-DECL",
    "undeclared global data symbol (global_<addr>)",
    "A", "packaging",
    "global symbol rendering (data symbol table -> declarations)",
    "high",
    "Global data referenced by address is rendered as an identifier the TU never "
    "declares. Required metadata is a global symbol declaration block.",
)
add(
    "A-NONSTANDARD-INT-ALIAS",
    "non-standard integer type alias (uint32 / uint64 / int64 / uint8)",
    "A", "packaging",
    "type alias rendering (bare alias names instead of typedefs)",
    "high",
    "Type names are emitted as bare uint32/uint64/int64/uint8, which are not C "
    "types. Both `unknown type name` in declaration position and `use of "
    "undeclared identifier` in cast position are this same producer gap.",
)
add(
    "A-STANDARD-TYPE-ALIAS",
    "standard fixed-width alias used without <stdint.h>",
    "A", "packaging",
    "type alias rendering / missing standard header emission",
    "high",
    "uint32_t / uint64_t / int32_t are used, but the TU includes no header and "
    "no typedef. Correct spelling, missing declaration.",
)
add(
    "A-MISSING-PROTOTYPE",
    "missing external function prototype (sub_<addr> and named callees)",
    "A", "packaging",
    "function prototype rendering / TU ownership boundary",
    "high",
    "Calls to functions defined later in the same TU, or never defined, reach "
    "the compiler with no prototype (implicit declaration; C99-invalid, an "
    "error from clang 16 / gcc 14 onward).",
)
add(
    "A-MANGLED-SYMBOL-PROTOTYPE",
    "C++ mangled symbol emitted as a C identifier and never declared",
    "A", "packaging",
    "symbol naming (mangled names) + prototype rendering",
    "high",
    "Mangled C++ names (_Z.../Z...) are emitted verbatim as C identifiers and "
    "called without a prototype. Distinct from A-MISSING-PROTOTYPE because the "
    "identifier itself is not a valid C-symbol contract.",
)
add(
    "A-MISSING-TYPE-DECL",
    "undeclared user/engine type name",
    "A", "packaging",
    "type declaration rendering",
    "medium",
    "Names such as vector128, Base, Derived, Container, std are used as type "
    "names or in cast position with no type declaration in the TU.",
)

# --- Category B: function-body / signature emission -------------------------
add(
    "B-UNDECLARED-STACK-SLOT",
    "undeclared stack-slot / local-memory pseudo-variable",
    "B", "emitter",
    "high-variable / stack-slot rendering (declaration emission missing)",
    "high",
    "local_<off>, local_p<hex>, var_<off>, field_<off> are used as lvalues and "
    "rvalues inside the function body with no local declaration. These are "
    "body-scoped and are not TU-level packaging gaps.",
)
add(
    "B-UNDECLARED-VALUE-PSEUDO-VAR",
    "undeclared value/return pseudo-variable (v0, v165, v1010, ...)",
    "B", "emitter",
    "SSA value materialization / temporary generation",
    "high",
    "SSA value indices are emitted with a `v` prefix (v165, v1010) and used as "
    "operands with no declaration. Shares the spelling space with ARM64 SIMD "
    "registers v0..v31.",
)
add(
    "B-UNDECLARED-REGISTER-PSEUDO-VAR",
    "undeclared register pseudo-variable (x0, x19, w0, d0, ...)",
    "B", "emitter",
    "high-variable / register pseudo-variable rendering",
    "high",
    "Raw architecture register names (x0, x0_1, x19, w0, d0, q0) escape into "
    "the body as ordinary identifiers without declaration.",
)
add(
    "B-UNDECLARED-ARG-PSEUDO-VAR",
    "undeclared parameter/return pseudo-variable (a1, a2, v0, ...)",
    "B", "emitter",
    "function signature rendering vs body variable rendering",
    "high",
    "The emitted signature does not declare the parameters the body uses "
    "(e.g. `void f(void)` whose body reads a1, a2, a3), so argument "
    "pseudo-variables are undeclared.",
)
add(
    "B-UNDECLARED-CALL-TEMP",
    "undeclared generated call temporary (call_<n>)",
    "B", "emitter",
    "temporary generation inside the body emitter",
    "high",
    "Per-call result temporaries are generated and consumed without ever being "
    "declared. Pure body-scoped temporaries.",
)
add(
    "B-UNDECLARED-PHI-TEMP",
    "undeclared SSA phi temporary (local_phi_*)",
    "B", "emitter",
    "SSA phi lowering / temporary generation",
    "high",
    "SSA phi temporaries are emitted as identifiers rather than being lowered "
    "into declared locals.",
)
add(
    "B-UNDECLARED-CONDITION-TEMP",
    "undeclared condition temporary (condition_*)",
    "B", "emitter",
    "condition/temporary generation",
    "medium",
    "Condition temporaries (condition_eq, condition_hi, condition_le, ...) are "
    "referenced without declaration.",
)
add(
    "B-UNDECLARED-ARCH-REGISTER",
    "undeclared raw architecture register (sp, lr, pc)",
    "B", "emitter",
    "register rendering",
    "high",
    "sp/lr/pc are emitted as C identifiers.",
)
add(
    "B-LABEL-BEFORE-BODY",
    "label emitted before the function body compound statement",
    "B", "emitter",
    "function signature/body assembly ordering",
    "high",
    "A `loc_<hex>:` label is emitted between the declarator and the opening "
    "brace: `uint64 f(void)\\n  loc_9A0:\\n{`. Invalid at file scope; the label "
    "belongs inside the body.",
)
add(
    "B-STATEMENT-OUTSIDE-FUNCTION",
    "statement emitted outside any function body",
    "B", "emitter",
    "body emission boundary / statement ownership",
    "high",
    "A `goto loc_<hex>;` is emitted after the function's closing brace, at file "
    "scope, producing `expected identifier or '('`.",
)
add(
    "B-INVALID-DECLARATOR-NAME",
    "invalid C declarator name (C++ qualified / demangled names)",
    "B", "emitter",
    "function name rendering",
    "high",
    "Names such as `thunk to MultiDerived::funcB` or `Container::get` are "
    "emitted as C declarators, producing `expected ';' after top level "
    "declarator` and `variable has incomplete type 'void'`.",
)
add(
    "B-UNDECLARED-LABEL",
    "goto to a label the emitted body never defines",
    "B", "emitter",
    "control-flow structuring / label emission",
    "high",
    "`goto loc_<hex>;` references a label that is not present in the emitted "
    "function, so the control-flow structuring and label emission disagree.",
)
add(
    "B-DUPLICATE-EMITTED-SYMBOL",
    "same emitted symbol defined more than once",
    "B", "emitter",
    "symbol naming / function identity rendering",
    "high",
    "Placeholder names ($x) and parameter-resolved names are reused, producing "
    "`redefinition of 'X'`.",
)
add(
    "B-IMPLICIT-VS-DEFINITION-CONFLICT",
    "later definition conflicts with an earlier implicit declaration",
    "B", "emitter (consequence of A-MISSING-PROTOTYPE)",
    "prototype rendering ordering",
    "high",
    "A call before the definition creates an implicit `int f()` declaration; "
    "the later `void f(void)` definition then conflicts. Root cause is the "
    "missing forward prototype, surfaced as a type conflict.",
    independent=False, cascade_of="A-MISSING-PROTOTYPE",
)
add(
    "B-INCOMPLETE-TYPE-DECLARATION",
    "declaration with incomplete type",
    "B", "emitter",
    "declarator / type rendering",
    "medium",
    "Invalid declarators (C++ qualified names) parse as a variable of type "
    "`void`, producing `variable has incomplete type 'void'`.",
    independent=False, cascade_of="B-INVALID-DECLARATOR-NAME",
)
add(
    "B-ARG-COUNT-MISMATCH",
    "call argument count contradicts an emitted zero-arg declaration",
    "B", "emitter (consequence of A-MISSING-PROTOTYPE)",
    "call rendering vs signature rendering",
    "high",
    "Call sites pass arguments while another emitted (void) declaration of the "
    "same name claims zero parameters.",
    independent=False, cascade_of="A-MISSING-PROTOTYPE",
)
add(
    "B-INVALID-MEMBER-ACCESS",
    "member access on a non-struct base (dotted symbol names)",
    "B", "emitter",
    "symbol naming in call rendering",
    "high",
    "Names like `param_atomic_ops.constprop.0` are emitted as C identifiers; "
    "`.` parses as member access on a function name.",
)
add(
    "B-MALFORMED-EXPRESSION-CASCADE",
    "malformed expression caused by an undeclared type name",
    "B", "emitter (cascade of A-NONSTANDARD-INT-ALIAS)",
    "expression / cast rendering",
    "high",
    "`*(uint64 *)0x13FD0` fails as `expected expression` because uint64 is not "
    "a declared type. This is a downstream cascade, not an independent defect.",
    independent=False, cascade_of="A-NONSTANDARD-INT-ALIAS",
)
add(
    "B-UNRESOLVED-OPERAND-PLACEHOLDER",
    "unresolved operand emitted as a literal `?` token",
    "B", "emitter",
    "expression rendering (unresolved operand)",
    "high",
    "A statement is emitted with `?` in operand position (e.g. `? = *(uint64 "
    "*)(x1);`), producing `expected ':'`. A printer placeholder escapes into "
    "the output as a token instead of a value.",
)
add(
    "B-ENTRY-SIGNATURE",
    "entry point rendered with a non-int return type",
    "B", "emitter",
    "function signature rendering (entry point)",
    "high",
    "The emitted `main` does not have type `int ()`, so clang warns with "
    "-Wmain-return-type. A signature-rendering defect, not a missing declaration.",
)
add(
    "B-STRING-CONCAT-EMISSION",
    "string literal combined with arithmetic instead of concatenation",
    "B", "emitter",
    "expression rendering (string literal operands)",
    "medium",
    "`\"literal\" + i` is emitted where C requires indexing; clang warns that "
    "adding to a string does not append.",
)
add(
    "C-CASCADE-RECOVERY",
    "parser recovery diagnostic caused by an earlier undeclared type",
    "C", "cascade (not an independent defect)",
    "expression / subscript rendering (recovery)",
    "medium",
    "`expected ']'` and similar recovery errors. All 34 `expected ']'` "
    "occurrences are on lines that also contain an undeclared int alias, so "
    "this is measurement noise from the type-alias gap, not a separate bug.",
    independent=False, cascade_of="A-NONSTANDARD-INT-ALIAS / A-STANDARD-TYPE-ALIAS",
)
add(
    "C-NOTE-SUPPORT",
    "compiler note attached to a parent diagnostic",
    "C", "supporting note",
    "n/a",
    "high",
    "clang `note:` diagnostics. They add evidence to a parent error but are not "
    "separate defects.",
    independent=False,
)

UNCLASSIFIED = {
    "id": "C-UNCLASSIFIED",
    "title": "unclassified diagnostic",
    "bucket": "C",
    "packagingVsEmitter": "ambiguous",
    "producerLayer": "unknown",
    "confidence": "low",
    "description": "Diagnostic not matched by any deterministic cluster rule.",
    "independentDefect": None,
    "cascadeOf": None,
}
TOOLCHAIN = {
    "id": "D-TOOLCHAIN",
    "title": "environment / toolchain only",
    "bucket": "D",
    "packagingVsEmitter": "environment",
    "producerLayer": "n/a",
    "confidence": "high",
    "description": "Timeout, missing compiler, or non-source diagnostic.",
    "independentDefect": None,
    "cascadeOf": None,
}

INTRINSIC_HELPERS = re.compile(
    r"^(unknown_call|phi|bit_extract|bit_insert|sext|zext|trunc|"
    r"__a64_[A-Za-z0-9_]+|__arm64_[A-Za-z0-9_]+|N_[A-Za-z0-9_]+)$"
)
MANGLED = re.compile(r"^(_?Z[A-Za-z0-9_]+|_GLOBAL__sub_I_.*)$")


def cluster_of(diag, line_text=None):
    msg = diag["message"]
    sev = diag["severity"]
    if sev == "linker/other":
        return "D-TOOLCHAIN"
    if sev == "note":
        return "C-NOTE-SUPPORT"

    # --- structural family rules -------------------------------------------
    if "Wmain-return-type" in msg:
        return "B-ENTRY-SIGNATURE"
    if "does not append to the string" in msg:
        return "B-STRING-CONCAT-EMISSION"
    if "expected function body after function declarator" in msg:
        return "B-LABEL-BEFORE-BODY"
    if "expected identifier or '('" in msg:
        return "B-STATEMENT-OUTSIDE-FUNCTION"
    if "after top level declarator" in msg:
        return "B-INVALID-DECLARATOR-NAME"
    if "use of undeclared label" in msg:
        return "B-UNDECLARED-LABEL"
    if "redefinition of" in msg:
        return "B-DUPLICATE-EMITTED-SYMBOL"
    if "conflicting types for" in msg:
        return "B-IMPLICIT-VS-DEFINITION-CONFLICT"
    if "variable has incomplete type" in msg:
        return "B-INCOMPLETE-TYPE-DECLARATION"
    if "too many arguments to function call" in msg:
        return "B-ARG-COUNT-MISMATCH"
    if "member reference base type" in msg:
        return "B-INVALID-MEMBER-ACCESS"
    if msg.startswith("expected expression"):
        return "B-MALFORMED-EXPRESSION-CASCADE"
    if msg.startswith("expected ':'"):
        return "B-UNRESOLVED-OPERAND-PLACEHOLDER"
    if msg.startswith("expected ']'") or msg.startswith("expected ')'"):
        return "C-CASCADE-RECOVERY"

    # --- identifier rules ---------------------------------------------------
    m = re.search(r"use of undeclared identifier '([^']+)'", msg)
    if m:
        name = m.group(1)
        cat, kind = classify_identifier(name)
        mapped = {
            "missing-runtime-declaration": "A-RUNTIME-HELPER-DECL",
            "missing-global-declaration": "A-GLOBAL-DATA-DECL",
            "missing-typedef/nonstandard-integer-alias": "A-NONSTANDARD-INT-ALIAS",
            "missing-standard-type-alias": "A-STANDARD-TYPE-ALIAS",
            "missing-typedef/vector-alias": "A-MISSING-TYPE-DECL",
            "missing-type-declaration": "A-MISSING-TYPE-DECL",
            "missing-entry-point": "A-MISSING-TYPE-DECL",
            "missing-external-function-declaration": "A-MISSING-PROTOTYPE",
            "undeclared-stack-slot-variable": "B-UNDECLARED-STACK-SLOT",
            "undeclared-gpr64-pseudo-variable": "B-UNDECLARED-REGISTER-PSEUDO-VAR",
            "undeclared-gpr32-pseudo-variable": "B-UNDECLARED-REGISTER-PSEUDO-VAR",
            "undeclared-simd-pseudo-variable": "B-UNDECLARED-REGISTER-PSEUDO-VAR",
            "undeclared-argument-pseudo-variable": "B-UNDECLARED-ARG-PSEUDO-VAR",
            "undeclared-value-pseudo-variable": "B-UNDECLARED-VALUE-PSEUDO-VAR",
            "undeclared-architecture-register": "B-UNDECLARED-ARCH-REGISTER",
            "undeclared-generated-call-temporary": "B-UNDECLARED-CALL-TEMP",
            "undeclared-ssa-phi-temporary": "B-UNDECLARED-PHI-TEMP",
            "undeclared-condition-temporary": "B-UNDECLARED-CONDITION-TEMP",
            "undeclared-emitter-placeholder": "B-UNDECLARED-STACK-SLOT",
        }.get(kind)
        if mapped:
            return mapped
        # A variable declared with a bare non-standard alias (`for (int64 i = ...)`)
        # is never really declared, so its later uses are a cascade of the
        # missing alias, not an independent emitter defect.
        if line_text and re.search(
            r"\bu?int(8|16|32|64|128)\b[^;=]*\b" + re.escape(name) + r"\b", line_text
        ):
            return "C-CASCADE-RECOVERY"
        return "C-UNCLASSIFIED"

    m = re.search(r"unknown type name '([^']+)'", msg)
    if m:
        name = m.group(1)
        cat, kind = classify_identifier(name)
        if kind == "missing-typedef/nonstandard-integer-alias":
            return "A-NONSTANDARD-INT-ALIAS"
        if kind in ("missing-standard-type-alias",):
            return "A-STANDARD-TYPE-ALIAS"
        return "A-MISSING-TYPE-DECL"

    m = re.search(r"implicit declaration of function '([^']+)'", msg)
    if m:
        name = m.group(1)
        if INTRINSIC_HELPERS.match(name):
            return "A-RUNTIME-HELPER-DECL"
        if MANGLED.match(name):
            return "A-MANGLED-SYMBOL-PROTOTYPE"
        return "A-MISSING-PROTOTYPE"

    return "C-UNCLASSIFIED"


def find_function(line_map, line):
    if line is None:
        return None
    for f in line_map:
        if f["startLine"] <= line <= f["endLine"]:
            return f
    return None


def snippet(source_path, line, before=2, after=2):
    if line is None:
        return None
    try:
        with open(source_path, "r", encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return None
    lo = max(1, line - before)
    hi = min(len(lines), line + after)
    return "\n".join("%d: %s" % (i + 1, lines[i]) for i in range(lo - 1, hi))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--base-sha", required=True)
    args = ap.parse_args()

    occ = collections.Counter()
    sev_occ = collections.defaultdict(collections.Counter)
    caseset = collections.defaultdict(set)
    funcset = collections.defaultdict(set)
    first_diag_cluster = collections.Counter()
    first_error_cluster = collections.Counter()
    representative = {}
    subjects = collections.defaultdict(collections.Counter)
    detail = collections.defaultdict(collections.Counter)

    case_profiles = []

    for path in sorted(glob.glob(os.path.join(args.raw_dir, "*.json"))):
        with open(path, "r", encoding="utf-8") as fh:
            r = json.load(fh)
        cid = r["caseId"]
        diags = r["syntax"]["diagnostics"]
        detail[cid]["diags"] = len(diags)
        try:
            with open(r["sourceFile"], "r", encoding="utf-8") as fh:
                src_lines = fh.read().splitlines()
        except OSError:
            src_lines = []

        # cluster every diagnostic for this case, in emission order
        tagged = []
        for d in diags:
            line_text = (
                src_lines[d["line"] - 1]
                if d["line"] and 0 < d["line"] <= len(src_lines)
                else None
            )
            cidk = cluster_of(d, line_text)
            tagged.append((cidk, d))

        if tagged:
            first_diag_cluster[tagged[0][0]] += 1
        for cl, d in tagged:
            if d["severity"] in ("error", "fatal error"):
                first_error_cluster[cl] += 1
                break

        a_root = b_root = a_all = b_all = 0
        for cl, d in tagged:
            occ[cl] += 1
            sev_occ[cl][d["severity"]] += 1
            caseset[cl].add(cid)
            fn = find_function(r["lineMap"], d["line"])
            if fn is not None:
                funcset[cl].add((cid, fn["name"], fn["address"]))
                detail[cid][("fn_" + cl)] = detail[cid].get(("fn_" + cl), 0)
            if cl not in representative:
                representative[cl] = {
                    "caseId": cid,
                    "function": fn["name"] if fn else None,
                    "line": d["line"],
                    "severity": d["severity"],
                    "message": d["message"],
                    "snippet": snippet(r["sourceFile"], d["line"]),
                }
            mm = re.search(r"'([^']+)'", d["message"])
            if mm:
                subjects[cl][mm.group(1)] += 1
            if cl.startswith("A"):
                a_all += 1
                if C[cl]["independentDefect"]:
                    a_root += 1
            elif cl.startswith("B"):
                b_all += 1
                if C[cl]["independentDefect"]:
                    b_root += 1

        if a_root and not b_root:
            prof = "packaging-only"
        elif b_root and not a_root:
            prof = "emitter-only"
        elif a_root and b_root:
            prof = "mixed"
        else:
            prof = "unknown"
        case_profiles.append(
            {
                "caseId": cid,
                "aRoot": a_root,
                "bRoot": b_root,
                "aAll": a_all,
                "bAll": b_all,
                "profile": prof,
            }
        )

    clusters = []
    for cid in sorted(C):
        meta = C[cid]
        clusters.append(
            {
                **meta,
                "occurrenceCount": occ[cid],
                "errorOccurrences": sev_occ[cid]["error"] + sev_occ[cid]["fatal error"],
                "warningOccurrences": sev_occ[cid]["warning"],
                "noteOccurrences": sev_occ[cid]["note"],
                "caseCount": len(caseset[cid]),
                "caseIds": sorted(caseset[cid]),
                "functionCount": len(funcset[cid]),
                "firstDiagnosticCaseCount": first_diag_cluster[cid],
                "firstErrorCaseCount": first_error_cluster[cid],
                "distinctSubjects": len(subjects[cid]),
                "topSubjects": subjects[cid].most_common(12),
                "representative": representative.get(cid),
            }
        )
    clusters.append(
        {
            **UNCLASSIFIED,
            "occurrenceCount": occ["C-UNCLASSIFIED"],
            "errorOccurrences": sev_occ["C-UNCLASSIFIED"]["error"],
            "warningOccurrences": sev_occ["C-UNCLASSIFIED"]["warning"],
            "noteOccurrences": sev_occ["C-UNCLASSIFIED"]["note"],
            "caseCount": len(caseset["C-UNCLASSIFIED"]),
            "caseIds": sorted(caseset["C-UNCLASSIFIED"]),
            "functionCount": len(funcset["C-UNCLASSIFIED"]),
            "firstDiagnosticCaseCount": first_diag_cluster["C-UNCLASSIFIED"],
            "firstErrorCaseCount": first_error_cluster["C-UNCLASSIFIED"],
            "distinctSubjects": len(subjects["C-UNCLASSIFIED"]),
            "topSubjects": subjects["C-UNCLASSIFIED"].most_common(12),
            "representative": representative.get("C-UNCLASSIFIED"),
        }
    )
    clusters.append(
        {
            **TOOLCHAIN,
            "occurrenceCount": occ["D-TOOLCHAIN"],
            "errorOccurrences": 0,
            "warningOccurrences": 0,
            "noteOccurrences": 0,
            "caseCount": len(caseset["D-TOOLCHAIN"]),
            "caseIds": sorted(caseset["D-TOOLCHAIN"]),
            "functionCount": len(funcset["D-TOOLCHAIN"]),
            "firstDiagnosticCaseCount": first_diag_cluster["D-TOOLCHAIN"],
            "firstErrorCaseCount": first_error_cluster["D-TOOLCHAIN"],
            "distinctSubjects": len(subjects["D-TOOLCHAIN"]),
            "topSubjects": subjects["D-TOOLCHAIN"].most_common(12),
            "representative": representative.get("D-TOOLCHAIN"),
        }
    )

    profiles = collections.Counter(p["profile"] for p in case_profiles)

    doc = {
        "schema": "hex-direct-recompilability-taxonomy/v1",
        "baseSha": args.base_sha,
        "stage1Artifact": "compiler-diagnostics.json",
        "taxonomyDefinition": {
            "A": "translation-unit packaging / declaration completeness",
            "B": "decompiler function-body (and signature) emission defect",
            "C": "ambiguous / mixed",
            "D": "environment or toolchain only",
            "counting": (
                "occurrenceCount counts every diagnostic instance across all 160 "
                "cases; caseCount counts distinct cases; functionCount counts "
                "distinct (case, function name, address) triples implicated via "
                "the reconstruction line map"
            ),
        },
        "buckets": {
            b: {
                "occurrenceCount": sum(occ[c["id"]] for c in clusters if c["bucket"] == b),
                "caseCount": len(set().union(*[caseset[c["id"]] for c in clusters if c["bucket"] == b])) if any(c["bucket"] == b for c in clusters) else 0,
                "clusterCount": sum(1 for c in clusters if c["bucket"] == b),
            }
            for b in ("A", "B", "C", "D")
        },
        "caseProfiles": dict(profiles),
        "caseProfileDetail": case_profiles,
        "clusters": clusters,
    }

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)

    print("caseProfiles:", dict(profiles))
    for c in clusters:
        print(
            "%-34s %-6s occ=%-7d cases=%-4d fns=%-6d first=%-4d"
            % (
                c["id"],
                c["bucket"],
                c["occurrenceCount"],
                c["caseCount"],
                c["functionCount"],
                c["firstDiagnosticCaseCount"],
            )
        )


if __name__ == "__main__":
    main()
