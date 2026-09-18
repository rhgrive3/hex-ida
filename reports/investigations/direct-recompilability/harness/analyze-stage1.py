#!/usr/bin/env python3
"""Stage 1 analyzer: turn the raw per-case compile records into
compiler-diagnostics.json.

Deterministic, no LLM, no network.

Definitions used here (documented in 00-baseline.md):
  firstDiagnostic  = the very first diagnostic clang printed (may be a warning)
  firstError       = the first diagnostic with severity error/fatal error
  diagnosticClass  = A/B/C/D classification of firstError
  implicatedLine   = 1-based line in the reconstructed translation unit
  implicatedFunction = the pseudocode function whose emitted line range contains
                       implicatedLine, using the reconstruction line map

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

HARNESS_DIR = os.path.dirname(os.path.abspath(__file__))
import sys

sys.path.insert(0, HARNESS_DIR)
from identifier_taxonomy import classify_identifier  # noqa: E402

MSG_IDENT_RE = re.compile(r"use of undeclared identifier '([^']+)'")
MSG_TYPE_RE = re.compile(r"unknown type name '([^']+)'")
MSG_ANY_IDENT_RE = re.compile(r"'([^']+)'")


def norm_family(message: str) -> str:
    m = re.sub(r"'[^']*'", "'X'", message)
    m = re.sub(r"0x[0-9A-Fa-f]+", "0xN", m)
    m = re.sub(r"\b\d+\b", "N", m)
    m = re.sub(r"\[-W[^\]]+\]", "", m).strip()
    return m


def find_implicated(line_map, line):
    if line is None:
        return None, None
    best = None
    for f in line_map:
        if f["startLine"] <= line <= f["endLine"]:
            return f, line - f["startLine"] + 1
        if f["startLine"] <= line:
            best = f
    if best is not None:
        return best, line - best["startLine"] + 1
    return None, None


def snippet(source_path, line, context=0):
    if line is None:
        return None
    try:
        with open(source_path, "r", encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return None
    lo = max(1, line - context)
    hi = min(len(lines), line + context)
    return "\n".join(
        "%d: %s" % (i + 1, lines[i]) for i in range(lo - 1, hi)
    )


def classify_message(diag):
    """Classify a single diagnostic; returns (category, kind, subject)."""
    msg = diag["message"]
    sev = diag["severity"]
    if sev == "linker/other":
        return "D", "toolchain/link-diagnostic", msg[:80]
    m = MSG_IDENT_RE.search(msg)
    if m:
        name = m.group(1)
        cat, kind = classify_identifier(name)
        return cat, kind, name
    m = MSG_TYPE_RE.search(msg)
    if m:
        name = m.group(1)
        cat, kind = classify_identifier(name)
        if cat == "C":
            cat, kind = "A", "missing-type-declaration"
        return cat, kind, name
    fam = norm_family(msg)
    # Structural / emission-shape diagnostics that are produced by the body or
    # signature emitter rather than by a missing TU-level declaration.
    emitter_families = {
        "expected function body after function declarator",
        "expected identifier or 'X'",
        "expected 'X' after top level declarator",
        "expected 'X'",
        "expected expression",
        "use of undeclared label 'X'",
        "redefinition of 'X'",
        "redefinition of 'X' as different kind of symbol",
        "variable has incomplete type 'X'",
        "member reference base type 'X' is not a structure or union",
        "conflicting types for 'X'",
        "too many arguments to function call, expected N, have N",
    }
    if fam in emitter_families:
        # `expected expression` is almost always a cast whose type name is
        # itself undeclared; surface that as A when the cast type is a known
        # non-standard alias, otherwise keep it in B.
        if fam == "expected expression":
            t = re.search(r"\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)", msg)
            return "C", "cascade/expected-expression", msg[:80]
        return "B", "emitter/" + fam, None
    return "C", "unclassified", msg[:80]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--base-sha", required=True)
    ap.add_argument("--compiler-version", required=True)
    ap.add_argument("--recon-rule", required=True)
    args = ap.parse_args()

    cases = []
    class_counts = collections.Counter()
    first_error_family = collections.Counter()
    first_error_kind = collections.Counter()

    for path in sorted(glob.glob(os.path.join(args.raw_dir, "*.json"))):
        with open(path, "r", encoding="utf-8") as fh:
            r = json.load(fh)
        diags = r["syntax"]["diagnostics"]
        errors = [d for d in diags if d["severity"] in ("error", "fatal error")]
        warnings = [d for d in diags if d["severity"] == "warning"]
        notes = [d for d in diags if d["severity"] == "note"]

        first_diag = diags[0] if diags else None
        first_err = errors[0] if errors else None

        cat, kind, subject = (
            classify_message(first_err) if first_err else ("D", "no-diagnostic", None)
        )
        fn, fn_line = find_implicated(r["lineMap"], first_err["line"] if first_err else None)

        syntax_pass = r["syntax"]["exitCode"] == 0 and not r["syntax"]["timedOut"]
        link = r["link"]
        link_pass = link.get("attempted") and link.get("exitCode") == 0

        class_counts[cat] += 1
        first_error_family[norm_family(first_err["message"]) if first_err else "none"] += 1
        first_error_kind[kind] += 1

        cases.append(
            {
                "caseId": r["caseId"],
                "artifactFile": r["artifactFile"],
                "inputSha256": r.get("inputSha256"),
                "sourceSha256": r["sourceSha256"],
                "sourceFile": r["sourceFile"],
                "sourceBytes": r["sourceBytes"],
                "pseudocodeFunctionCount": r["pseudocodeFunctionCount"],
                "compilerCommand": r["syntax"]["command"],
                "compilerVersion": args.compiler_version,
                "syntaxPass": syntax_pass,
                "linkPass": bool(link_pass),
                "linkStageReachable": bool(link.get("attempted")),
                "linkSkipReason": link.get("skippedReason"),
                "errorCount": len(errors),
                "warningCount": len(warnings),
                "noteCount": len(notes),
                "firstDiagnostic": (
                    {
                        "severity": first_diag["severity"],
                        "line": first_diag["line"],
                        "col": first_diag["col"],
                        "family": norm_family(first_diag["message"]),
                        "message": first_diag["message"],
                    }
                    if first_diag
                    else None
                ),
                "firstError": (
                    {
                        "line": first_err["line"],
                        "col": first_err["col"],
                        "family": norm_family(first_err["message"]),
                        "message": first_err["message"],
                        "subject": subject,
                        "kind": kind,
                    }
                    if first_err
                    else None
                ),
                "diagnosticClass": cat,
                "implicatedFunction": fn["name"] if fn else None,
                "implicatedFunctionState": fn["state"] if fn else None,
                "implicatedLine": first_err["line"] if first_err else None,
                "implicatedFunctionLine": fn_line,
                "implicatedSnippet": snippet(
                    r["sourceFile"], first_err["line"] if first_err else None
                ),
            }
        )

    doc = {
        "schema": "hex-direct-recompilability-baseline/v1",
        "baseSha": args.base_sha,
        "compiler": {"name": "clang", "version": args.compiler_version},
        "hostTarget": "x86_64-pc-linux-gnu (host), NOT ARM64 native",
        "reconstructionRule": args.recon_rule,
        "linkStageNote": (
            "link stage was attempted only when the syntax/type stage passed; "
            "for cases where it did not, linkPass=false with "
            "linkStageReachable=false and is NOT an independent link measurement"
        ),
        "classificationDefinitions": {
            "A": "translation-unit packaging / declaration completeness",
            "B": "decompiler function-body emission defect",
            "C": "ambiguous / mixed",
            "D": "environment or toolchain only",
            "diagnosticClass": "category of the first severity=error diagnostic",
        },
        "summary": {
            "caseCount": len(cases),
            "syntaxPassCount": sum(1 for c in cases if c["syntaxPass"]),
            "linkPassCount": sum(1 for c in cases if c["linkPass"]),
            "linkStageReachableCount": sum(1 for c in cases if c["linkStageReachable"]),
            "diagnosticClassCounts": dict(class_counts),
            "firstErrorFamilyCounts": dict(first_error_family),
            "firstErrorKindCounts": dict(first_error_kind),
            "totalErrors": sum(c["errorCount"] for c in cases),
            "totalWarnings": sum(c["warningCount"] for c in cases),
        },
        "cases": cases,
    }

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
    print(json.dumps(doc["summary"], indent=1))


if __name__ == "__main__":
    main()
