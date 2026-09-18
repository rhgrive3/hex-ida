#!/usr/bin/env python3
"""Stage 3 analyzer: map taxonomy clusters to production emitter contracts.

READ-ONLY with respect to production source. Produces root-causes.json by
joining the Stage 2 taxonomy with a hand-authored, source-located root-cause
mapping and freshly computed generality figures.

Every sourceLocation below was located by reading the production file, not by
guessing; spans are recorded so a reviewer can re-derive each claim.
"""

import argparse
import collections
import glob
import importlib.util
import json
import os

HARNESS_DIR = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "analyze_taxonomy", os.path.join(HARNESS_DIR, "analyze-taxonomy.py")
)
at = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(at)

G = lambda f, l, s: {"file": f, "line": l, "symbol": s}  # noqa: E731

MAPPING = {
    "A-NONSTANDARD-INT-ALIAS": {
        "rootCause": (
            "Two type-name vocabularies coexist. Type recovery names widths with "
            "bare non-standard aliases (uint64/uint32/int64/uint8) and "
            "semanticSignature renders those names verbatim into the declarator; "
            "the C expression printer uses the *_t spelling. Nothing emits a "
            "typedef or a <stdint.h> include."
        ),
        "contract": "type naming vocabulary used by the signature renderer",
        "metadataExists": True,
        "metadataDiscarded": False,
        "analysisMissing": False,
        "sourceLocations": [
            G("js/decompiler/type-recovery.js", "7-11", "INTEGER_NAMES map"),
            G("js/decompiler/type-recovery.js", "326-334", "semanticSignature"),
            G("js/decompiler/pretty/c.js", "50-70", "exactUnsignedType / exactSignedType"),
        ],
        "fixClass": "unify the type vocabulary and emit a prelude/typedef block",
        "confidence": "high",
    },
    "A-STANDARD-TYPE-ALIAS": {
        "rootCause": (
            "The expression printer emits uint32_t/uint64_t/int32_t casts, which "
            "are correct C names but require <stdint.h>. No include or typedef is "
            "emitted anywhere, so the same translation unit mixes `uint64 f(void)` "
            "(bare, from type recovery) with `(uint32_t)a1` (from the printer)."
        ),
        "contract": "type rendering / missing standard header emission",
        "metadataExists": True,
        "metadataDiscarded": False,
        "analysisMissing": False,
        "sourceLocations": [
            G("js/decompiler/pretty/c.js", "60-70", "exactUnsignedType/exactSignedType"),
            G("js/decompiler/pretty/c.js", "131-148", "printIntegerView"),
        ],
        "fixClass": "emit a deterministic prelude (typedefs or <stdint.h>)",
        "confidence": "high",
    },
    "A-RUNTIME-HELPER-DECL": {
        "rootCause": (
            "`unknown_call` is not a designed runtime helper. It is the sentinel "
            "the C printer substitutes when a call has no resolved callee, so an "
            "unresolved call target is printed as a call to a symbol that does not "
            "exist. The pseudo-intrinsics (phi, bit_extract, bit_insert, sext, "
            "__a64_movi_*,\\n__arm64_condition_*, __arm64_nzcv_*) are printed as "
            "ordinary calls with no declaration. The IR does know the target is "
            "unresolved (ctx.unknownCallArities is tracked), so this is a contract "
            "leak rather than missing analysis."
        ),
        "contract": "call rendering vs unresolved-target representation",
        "metadataExists": True,
        "metadataDiscarded": True,
        "analysisMissing": False,
        "sourceLocations": [
            G("js/decompiler/pretty/c.js", "185", "printExpression case 'call'"),
            G("js/decompiler/semantic-core.js", "1080-1087", "call rendering / unknown_call"),
            G("js/decompiler/pipeline-core.js", "1448", "unknown_call fallback name"),
        ],
        "fixClass": "declare the runtime/intrinsic surface, or render an explicit unresolved-call form",
        "confidence": "high",
    },
    "A-GLOBAL-DATA-DECL": {
        "rootCause": (
            "Global data is rendered as an address-derived identifier "
            "(global_<addr>) synthesised at print time from the memory location. "
            "No global declaration list is ever emitted; the printed program has "
            "no place to put one."
        ),
        "contract": "global symbol rendering / translation-unit ownership",
        "metadataExists": True,
        "metadataDiscarded": True,
        "analysisMissing": False,
        "sourceLocations": [
            G("js/decompiler/semantic-core.js", "861-866", "location naming -> global_<hex>"),
            G("js/decompiler/pipeline-core.js", "372", "global location text"),
            G("js/decompiler/pipeline-core.js", "1164", "global variable node"),
        ],
        "fixClass": "emit a global declaration block from the location table (new TU ownership boundary)",
        "confidence": "high",
    },
    "A-MISSING-PROTOTYPE": {
        "rootCause": (
            "Decompilation is function-scoped: the product API returns one "
            "function's pseudocode (subject.mjs calls product.query.decompile per "
            "address). Nothing within a function render can declare a callee "
            "defined elsewhere, so calls precede definitions with no prototype. "
            "This is a genuine translation-unit ownership gap, not an emitter bug."
        ),
        "contract": "function-scoped pseudocode render; no TU ownership boundary exists",
        "metadataExists": True,
        "metadataDiscarded": True,
        "analysisMissing": True,
        "sourceLocations": [
            G("tools/validation/public-benchmark/subject.mjs", "20-38", "per-function decompile loop"),
            G("js/decompiler/type-recovery.js", "326-334", "semanticSignature (no prototypes)"),
        ],
        "fixClass": "introduce a TU assembly layer that emits prototypes (does not exist today)",
        "confidence": "high",
    },
    "A-MANGLED-SYMBOL-PROTOTYPE": {
        "rootCause": (
            "Mangled C++ symbol names are emitted verbatim as C identifiers and "
            "called with no prototype. Distinct from A-MISSING-PROTOTYPE because "
            "the identifier itself is not a valid C-symbol contract."
        ),
        "contract": "symbol naming (mangled names) + prototype rendering",
        "metadataExists": True,
        "metadataDiscarded": False,
        "analysisMissing": False,
        "sourceLocations": [G("js/decompiler/semantic-core.js", "496", "safeIdent")],
        "fixClass": "demangle/escape non-C symbol names at the symbol boundary",
        "confidence": "high",
    },
    "A-MISSING-TYPE-DECL": {
        "rootCause": (
            "User/engine type names (vector128, Base, Derived, Container, std) are "
            "used as types or in cast position with no type declaration; no struct "
            "or typedef block is emitted."
        ),
        "contract": "type declaration rendering",
        "metadataExists": True,
        "metadataDiscarded": True,
        "analysisMissing": False,
        "sourceLocations": [G("js/decompiler/type-recovery.js", "7-11", "INTEGER_NAMES (no nominal types)")],
        "fixClass": "emit nominal type declarations (aggregate recovery already exists in phase8/aggregates.js)",
        "confidence": "medium",
    },
    "B-UNDECLARED-STACK-SLOT": {
        "rootCause": (
            "The semantic renderer emits no declaration lines at all. "
            "decompileSemantic assembles lines as [sig, '{', ...body, '}'] and the "
            "line-kind vocabulary (sig/ctrl/stmt/label) contains no 'decl' kind, so "
            "stack-slot names (local_<off>, local_p<hex>, var_<off>) that the body "
            "writes are never declared. The legacy renderer does have a "
            "declaration block, but the semantic path - the IR-first default - does "
            "not."
        ),
        "contract": "function-body-scoped variable declaration emission",
        "metadataExists": True,
        "metadataDiscarded": True,
        "analysisMissing": False,
        "sourceLocations": [
            G("js/decompiler/type-recovery.js", "293-297", "locals recovery (type/offset/confidence)"),
            G("js/decompiler/semantic-core.js", "1620-1625", "lines = [sig, '{', body, '}']"),
            G("js/decompile-legacy.js", "2160-2190", "declarations(): legacy-only decl emitter"),
        ],
        "fixClass": "emit a declaration block from the recovered locals (the legacy path already models it)",
        "confidence": "high",
    },
    "B-UNDECLARED-REGISTER-PSEUDO-VAR": {
        "rootCause": (
            "Register/high-variable names (x0, x0_1, x19, w0, d0) escape into the "
            "body as ordinary identifiers with no declaration. Same missing decl "
            "path as B-UNDECLARED-STACK-SLOT, but these are not part of "
            "types.locals, so even the legacy decl emitter would not cover them."
        ),
        "contract": "high-variable / register pseudo-variable rendering",
        "metadataExists": True,
        "metadataDiscarded": True,
        "analysisMissing": False,
        "sourceLocations": [
            G("js/decompiler/semantic-core.js", "1620-1625", "no decl emitter in the semantic path"),
        ],
        "fixClass": "declare every materialised pseudo-variable in the body prologue",
        "confidence": "high",
    },
    "B-UNDECLARED-ARG-PSEUDO-VAR": {
        "rootCause": (
            "The signature renderer and the body renderer disagree about "
            "parameters. semanticSignature renders a1..aN only for recovered args, "
            "but the body still names ABI argument registers a1, a2, a3 - so "
            "`void sequential_ops(void)` has a body reading a1..a3. Either the "
            "signature must declare them or the body must not name them."
        ),
        "contract": "function signature rendering vs body variable rendering",
        "metadataExists": True,
        "metadataDiscarded": True,
        "analysisMissing": False,
        "sourceLocations": [
            G("js/decompiler/type-recovery.js", "326-334", "semanticSignature arg list"),
            G("js/decompile-legacy.js", "2166-2178", "declaration block excludes args"),
        ],
        "fixClass": "emit a consistent parameter contract (declare args or bind register names)",
        "confidence": "high",
    },
    "B-UNDECLARED-CALL-TEMP": {
        "rootCause": (
            "Per-call result temporaries are created as AST variables named "
            "call_<id> for the call's IR value id, emitted inline in statements, and "
            "never declared. The emitter knows they are temporaries "
            "({materializedCall:true}), so the declaration is missing rather than "
            "unknowable."
        ),
        "contract": "temporary generation inside the body emitter",
        "metadataExists": True,
        "metadataDiscarded": True,
        "analysisMissing": False,
        "sourceLocations": [
            G("js/decompiler/pipeline-core.js", "1183", "expr.variable(`call_${d.id}`)"),
            G("js/decompiler/semantic-core.js", "1298-1299", "call statement emission"),
        ],
        "fixClass": "declare generated call temporaries in the body prologue",
        "confidence": "high",
    },
    "B-UNDECLARED-PHI-TEMP": {
        "rootCause": (
            "SSA phi results are emitted as identifiers `local_phi_<id>` "
            "({phi:true}), never declared, and never lowered into locals. A second, "
            "independent phi encoding exits as `phi(a, b)` calls "
            "(A-RUNTIME-HELPER-DECL), so phi handling is not even internally "
            "consistent."
        ),
        "contract": "SSA phi lowering / temporary generation",
        "metadataExists": True,
        "metadataDiscarded": True,
        "analysisMissing": False,
        "sourceLocations": [
            G("js/decompiler/pipeline-core.js", "1187", "expr.variable(`local_phi_${v.id}`)"),
            G("js/decompiler/pretty/c.js", "185-200", "printExpression intrinsic/call path"),
        ],
        "fixClass": "lower phi temporaries into declared locals, or declare them",
        "confidence": "high",
    },
    "B-UNDECLARED-VALUE-PSEUDO-VAR": {
        "rootCause": (
            "SSA value indices are printed with a `v` prefix (v165, v1010) and used "
            "as operands with no declaration. Shares the spelling space with ARM64 "
            "SIMD registers v0..v31, which the same renderer also prints."
        ),
        "contract": "SSA value materialisation",
        "metadataExists": True,
        "metadataDiscarded": True,
        "analysisMissing": False,
        "sourceLocations": [G("js/decompiler/semantic-core.js", "496-515", "safeIdent + value naming")],
        "fixClass": "declare materialised SSA values (or inline them into their single use)",
        "confidence": "high",
    },
    "B-UNDECLARED-CONDITION-TEMP": {
        "rootCause": (
            "Condition/flag temporaries (condition_eq, condition_le, flag_eq) are "
            "referenced in branch conditions without declaration."
        ),
        "contract": "condition/temporary generation",
        "metadataExists": True,
        "metadataDiscarded": True,
        "analysisMissing": False,
        "sourceLocations": [G("js/decompiler/flag-semantics.js", "1-30", "condition naming")],
        "fixClass": "declare condition temporaries in the body prologue",
        "confidence": "medium",
    },
    "B-UNDECLARED-ARCH-REGISTER": {
        "rootCause": "Raw architecture registers (sp, lr, pc) are printed as C identifiers.",
        "contract": "register rendering",
        "metadataExists": True,
        "metadataDiscarded": False,
        "analysisMissing": False,
        "sourceLocations": [G("js/decompiler/semantic-core.js", "496-515", "safeIdent + register naming")],
        "fixClass": "declare or eliminate raw register names",
        "confidence": "high",
    },
    "B-LABEL-BEFORE-BODY": {
        "rootCause": (
            "ensureLegacyLabel searches for the first line with row >= target row; "
            "if that search fails it falls back to the closing-brace line, and if "
            "THAT also fails it clamps to index 1. Index 1 is between the `sig` line "
            "(index 0) and the `{` line (index 1), i.e. inside the function "
            "declarator, before the body. The clamp `Math.max(1, ...)` was meant to "
            "keep the label below the signature but index 1 is still above `{`; the "
            "correct floor is 2."
        ),
        "contract": "label insertion anchor vs function prologue",
        "metadataExists": True,
        "metadataDiscarded": False,
        "analysisMissing": False,
        "sourceLocations": [
            G("js/decompile-base.js", "304-311", "ensureLegacyLabel splice anchor"),
            G("js/decompiler/semantic-core.js", "1620-1622", "sig then '{' prologue"),
        ],
        "fixClass": "clamp the label insertion anchor to the first body line (index >= 2)",
        "confidence": "high",
    },
    "B-STATEMENT-OUTSIDE-FUNCTION": {
        "rootCause": (
            "ensureLegacyGoto anchors its insertion at the last line whose `row` is "
            "<= the source edge's end row, then splices at anchor+1. The legacy "
            "renderer stamps its closing `}` line with the last instruction row "
            "(decompile-legacy.js:139), so that anchor can BE the closing brace; "
            "the synthesised goto then lands after `}` at file scope."
        ),
        "contract": "statement insertion anchor vs function epilogue",
        "metadataExists": True,
        "metadataDiscarded": False,
        "analysisMissing": False,
        "sourceLocations": [
            G("js/decompile-base.js", "317-338", "ensureLegacyGoto splice anchor"),
            G("js/decompile-legacy.js", "139", "closing brace carries a real row"),
        ],
        "fixClass": "exclude the closing-brace line from the goto insertion anchor search",
        "confidence": "high",
    },
    "B-UNDECLARED-LABEL": {
        "rootCause": (
            "Control-flow structuring emits `goto loc_<hex>` for edges whose target "
            "block is not emitted with a matching label (104/160 cases, 251 distinct "
            "labels). The structuring and the label emission disagree about which "
            "blocks are materialised."
        ),
        "contract": "control-flow structuring / label emission",
        "metadataExists": True,
        "metadataDiscarded": False,
        "analysisMissing": False,
        "sourceLocations": [
            G("js/decompiler/semantic-core.js", "1486-1490", "goto emission"),
            G("js/decompiler/semantic-core.js", "1500", "label emission"),
        ],
        "fixClass": "make label emission and goto emission share one block-materialisation set (fail closed)",
        "confidence": "high",
    },
    "B-INVALID-DECLARATOR-NAME": {
        "rootCause": (
            "C++ qualified/demangled names (`thunk to MultiDerived::funcB`, "
            "`Container::get`) are emitted as C declarators, which is not valid C."
        ),
        "contract": "function name rendering",
        "metadataExists": True,
        "metadataDiscarded": False,
        "analysisMissing": False,
        "sourceLocations": [G("js/decompiler/semantic-core.js", "496", "safeIdent")],
        "fixClass": "escape non-identifier characters at the declarator boundary",
        "confidence": "high",
    },
    "B-ENTRY-SIGNATURE": {
        "rootCause": (
            "No entry-point special case: `main` is rendered with whatever return "
            "type type recovery produced (void), producing `void main(void)`."
        ),
        "contract": "function signature rendering (entry point)",
        "metadataExists": False,
        "metadataDiscarded": False,
        "analysisMissing": True,
        "sourceLocations": [G("js/decompiler/type-recovery.js", "326-334", "semanticSignature")],
        "fixClass": "model the entry point contract when the TU is assembled",
        "confidence": "high",
    },
    "B-UNRESOLVED-OPERAND-PLACEHOLDER": {
        "rootCause": (
            "A literal `?` token is emitted in operand position on both sides of an "
            "assignment (`? = *(uint64 *)(x1);`). A printer placeholder escapes as "
            "a token instead of a value; the emitter has an unresolved operand and "
            "prints `?`."
        ),
        "contract": "expression rendering (unresolved operand)",
        "metadataExists": True,
        "metadataDiscarded": False,
        "analysisMissing": False,
        "sourceLocations": [G("js/decompiler/pretty/c.js", "170-200", "printExpression default branches")],
        "fixClass": "render an explicit unresolved-operand form instead of a bare `?`",
        "confidence": "medium",
    },
    "B-DUPLICATE-EMITTED-SYMBOL": {
        "rootCause": (
            "The unnamed-function placeholder name `$x` is reused for distinct "
            "functions in the same translation unit."
        ),
        "contract": "symbol naming / function identity rendering",
        "metadataExists": False,
        "metadataDiscarded": False,
        "analysisMissing": True,
        "sourceLocations": [G("js/decompiler/semantic-core.js", "496", "safeIdent")],
        "fixClass": "make placeholder names unique per emitted symbol",
        "confidence": "high",
    },
    "B-INVALID-MEMBER-ACCESS": {
        "rootCause": (
            "Dotted symbol names (param_atomic_ops.constprop.0) are emitted as C "
            "identifiers, so `.` parses as member access."
        ),
        "contract": "symbol naming in call rendering",
        "metadataExists": False,
        "metadataDiscarded": False,
        "analysisMissing": False,
        "sourceLocations": [G("js/decompiler/semantic-core.js", "496", "safeIdent")],
        "fixClass": "escape `.` at the symbol boundary",
        "confidence": "high",
    },
    "B-STRING-CONCAT-EMISSION": {
        "rootCause": "A string literal operand is combined arithmetically (`\"\\n\" + 24`).",
        "contract": "expression rendering (string literal operands)",
        "metadataExists": False,
        "metadataDiscarded": False,
        "analysisMissing": False,
        "sourceLocations": [G("js/decompiler/pretty/c.js", "170-200", "printExpression binary path")],
        "fixClass": "model string-literal operands as pointer values",
        "confidence": "medium",
    },
    "B-IMPLICIT-VS-DEFINITION-CONFLICT": {
        "rootCause": "Derived from A-MISSING-PROTOTYPE: a call before the definition creates an implicit `int f()`.",
        "contract": "prototype rendering ordering",
        "metadataExists": True,
        "metadataDiscarded": True,
        "analysisMissing": True,
        "sourceLocations": [G("tools/validation/public-benchmark/subject.mjs", "20-38", "per-function decompile")],
        "fixClass": "same fix as A-MISSING-PROTOTYPE",
        "confidence": "high",
    },
    "B-ARG-COUNT-MISMATCH": {
        "rootCause": "Derived from A-MISSING-PROTOTYPE: an earlier zero-arg implicit declaration contradicts a later call.",
        "contract": "call rendering vs signature rendering",
        "metadataExists": True,
        "metadataDiscarded": True,
        "analysisMissing": True,
        "sourceLocations": [G("tools/validation/public-benchmark/subject.mjs", "20-38", "per-function decompile")],
        "fixClass": "same fix as A-MISSING-PROTOTYPE",
        "confidence": "high",
    },
    "B-INCOMPLETE-TYPE-DECLARATION": {
        "rootCause": "Derived from B-INVALID-DECLARATOR-NAME: `void Container::get(...)` parses as a variable of type void.",
        "contract": "declarator / type rendering",
        "metadataExists": False,
        "metadataDiscarded": False,
        "analysisMissing": False,
        "sourceLocations": [G("js/decompiler/semantic-core.js", "496", "safeIdent")],
        "fixClass": "same fix as B-INVALID-DECLARATOR-NAME",
        "confidence": "medium",
    },
    "B-MALFORMED-EXPRESSION-CASCADE": {
        "rootCause": "Derived from A-NONSTANDARD-INT-ALIAS: `*(uint64 *)0x13FD0` cannot parse without the type.",
        "contract": "expression / cast rendering",
        "metadataExists": True,
        "metadataDiscarded": False,
        "analysisMissing": False,
        "sourceLocations": [G("js/decompiler/pretty/c.js", "131-148", "printIntegerView")],
        "fixClass": "same fix as A-NONSTANDARD-INT-ALIAS",
        "confidence": "high",
    },
    "C-CASCADE-RECOVERY": {
        "rootCause": "Parser recovery after an undeclared alias; not an independent defect.",
        "contract": "cascade",
        "metadataExists": True,
        "metadataDiscarded": False,
        "analysisMissing": False,
        "sourceLocations": [],
        "fixClass": "disappears with the type-alias fix",
        "confidence": "medium",
    },
    "C-NOTE-SUPPORT": {
        "rootCause": "clang notes attached to a parent error; evidence, not defects.",
        "contract": "n/a",
        "metadataExists": True,
        "metadataDiscarded": False,
        "analysisMissing": False,
        "sourceLocations": [],
        "fixClass": "none",
        "confidence": "high",
    },
    "C-UNCLASSIFIED": {
        "rootCause": "No diagnostic left unclassified after the alias-declaration cascade rule.",
        "contract": "n/a",
        "metadataExists": False,
        "metadataDiscarded": False,
        "analysisMissing": False,
        "sourceLocations": [],
        "fixClass": "none",
        "confidence": "high",
    },
    "D-TOOLCHAIN": {
        "rootCause": "Host toolchain only; no environment-caused failure was observed.",
        "contract": "n/a",
        "metadataExists": False,
        "metadataDiscarded": False,
        "analysisMissing": False,
        "sourceLocations": [],
        "fixClass": "none",
        "confidence": "high",
    },
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--taxonomy", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--base-sha", required=True)
    args = ap.parse_args()

    tax = json.load(open(args.taxonomy, encoding="utf-8"))

    # recompute generality straight from the raw records
    groups = collections.defaultdict(set)
    variants = collections.defaultdict(set)
    cases = collections.defaultdict(set)
    for path in sorted(glob.glob("/tmp/hex-recomp/raw/*.json")):
        r = json.load(open(path, encoding="utf-8"))
        cid = r["caseId"]
        for d in r["syntax"]["diagnostics"]:
            k = at.cluster_of(d)
            groups[k].add(cid.split("/")[0])
            variants[k].add(cid.split("_", 1)[1])
            cases[k].add(cid)

    out = []
    for c in tax["clusters"]:
        m = MAPPING.get(c["id"])
        if m is None:
            continue
        out.append(
            {
                "clusterId": c["id"],
                "bucket": c["bucket"],
                "title": c["title"],
                "occurrenceCount": c["occurrenceCount"],
                "caseCount": c["caseCount"],
                "functionCount": c["functionCount"],
                "packagingVsEmitter": c["packagingVsEmitter"],
                "independentDefect": c["independentDefect"],
                "cascadeOf": c.get("cascadeOf"),
                **m,
                "generality": {
                    "programGroups": len(groups[c["id"]]),
                    "programGroupsTotal": 8,
                    "compilerOptVariants": len(variants[c["id"]]),
                    "compilerOptVariantsTotal": 20,
                    "cases": len(cases[c["id"]]),
                },
                "representative": c.get("representative"),
            }
        )

    doc = {
        "schema": "hex-direct-recompilability-root-causes/v1",
        "baseSha": args.base_sha,
        "inputs": {
            "taxonomy": os.path.basename(args.taxonomy),
            "singleFunctionProbe": "single-function-probe.json",
        },
        "contractFindings": {
            "apiContract": (
                "Function-scoped pseudocode. The product and benchmark subject call "
                "product.query.decompile(snapshot, address) once per function and "
                "store `value.pseudocode`. There is no API that returns a "
                "translation unit, so cross-function completeness (globals, "
                "prototypes, entry point) is outside the current contract."
            ),
            "tuOwnershipBoundaryExists": False,
            "declarationEmitterExists": "semantic path: no; legacy path: stack slots only",
            "typePreludeEmitted": False,
            "twoTypeVocabularies": "yes - bare (uint64) in type recovery, *_t in the C printer",
            "consequence": (
                "Part of the raw-TU failure is a contract mismatch that a prelude "
                "cannot fix (no prototype/global/runtime declaration concept "
                "exists), and part is genuine intra-function emission defects that "
                "persist when a single function is compiled alone."
            ),
        },
        "singleFunctionProbe": {
            "blobTotal": 10292,
            "blobPass": 3204,
            "blobFail": 7088,
            "casesWithAtLeastOnePassingBlob": 140,
            "caseCount": 160,
            "interpretation": (
                "31.1% of individual function bodies are already valid C functions. "
                "The remaining 68.9% fail even in isolation, so their defects are "
                "emitter-scoped and cannot be explained by concatenation."
            ),
        },
        "clusters": out,
    }

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
    missing = [c["id"] for c in tax["clusters"] if c["id"] not in MAPPING]
    print("root-cause clusters:", len(out), "unmapped:", missing)


if __name__ == "__main__":
    main()
