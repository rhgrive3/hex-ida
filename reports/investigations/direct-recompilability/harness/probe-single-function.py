#!/usr/bin/env python3
"""Stage 3 focused probe: single-function recompilability.

Stage 1 compiled the *concatenation* of every function in a case, which mixes
two different questions:

  (a) is a function's own emitted text a valid C function definition?  and
  (b) is there a standalone translation unit around it?

This probe removes cross-function concatenation effects by compiling one
pseudocode blob per translation unit, with nothing added or repaired. A remaining
failure is still ambiguous between missing standalone declarations/headers/
prototypes and an intra-function emitter defect; isolation alone does not decide
which side owns the defect.

Not a benchmark. It is a bounded diagnostic probe over the frozen corpus.
"""

import argparse
import collections
import glob
import json
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "analyze_taxonomy",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "analyze-taxonomy.py"),
)
analyze_taxonomy = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(analyze_taxonomy)
cluster_of = analyze_taxonomy.cluster_of


def norm_family(message):
    m = re.sub(r"'[^']*'", "'X'", message)
    m = re.sub(r"0x[0-9A-Fa-f]+", "0xN", m)
    m = re.sub(r"\b\d+\b", "N", m)
    m = re.sub(r"\[-W[^\]]+\]", "", m).strip()
    return m

PER_CASE_TIMEOUT_S = 5.0
GLOBAL_DEADLINE_S = 600.0


def _line_text(source, first):
    if not first or not source:
        return None
    lines = source.splitlines()
    line = first.get("line")
    if not isinstance(line, int) or line <= 0 or line > len(lines):
        return None
    return lines[line - 1]


def _compact(blobs):
    per = collections.defaultdict(
        lambda: {"candidates": 0, "attempted": 0, "completed": 0,
                 "pass": 0, "fail": 0, "skipped": 0, "timedOut": 0}
    )
    fail_families = collections.Counter()
    fail_clusters = collections.Counter()
    candidate_cases = set()
    candidates = attempted = completed = passed = skipped = timed_out = 0
    failing_samples = []

    for b in blobs:
        cid = b["caseId"]
        candidate_cases.add(cid)
        candidates += 1
        per[cid]["candidates"] += 1

        if b.get("skipped"):
            skipped += 1
            per[cid]["skipped"] += 1
            continue

        attempted += 1
        per[cid]["attempted"] += 1
        if b.get("timedOut"):
            timed_out += 1
            per[cid]["timedOut"] += 1
            continue

        completed += 1
        per[cid]["completed"] += 1
        if b.get("pass") is True:
            passed += 1
            per[cid]["pass"] += 1
            continue

        per[cid]["fail"] += 1
        first = b.get("firstError")
        if first:
            fail_families[norm_family(first["message"])] += 1
            fail_clusters[cluster_of(
                {"severity": "error", **first},
                b.get("sourceLine"),
            )] += 1
        if len(failing_samples) < 200:
            failing_samples.append(b)

    return {
        "schema": "hex-direct-recompilability-single-function-probe/v2",
        "note": (
            "Each pseudocode blob is compiled alone with no prelude or repair. "
            "Isolation removes cross-function concatenation effects but does not "
            "separate missing standalone declarations from emitter defects."
        ),
        "blobCandidates": candidates,
        "blobAttempted": attempted,
        "blobCompleted": completed,
        "blobTotal": completed,
        "blobPass": passed,
        "blobFail": completed - passed,
        "blobSkipped": skipped,
        "blobTimedOut": timed_out,
        "failFamilies": dict(fail_families.most_common(20)),
        "failClusters": dict(fail_clusters.most_common(20)),
        "casesWithAtLeastOnePassingBlob": sum(
            1 for stats in per.values() if stats["pass"] > 0
        ),
        "caseCount": len(candidate_cases),
        "completedCaseCount": sum(
            1 for stats in per.values() if stats["completed"] > 0
        ),
        "perCase": {k: per[k] for k in sorted(per)},
        "failingBlobSamples": failing_samples,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bench-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--clang", default="clang")
    ap.add_argument("--tmp", default="/tmp/hex-recomp-single")
    ap.add_argument("--full", default=None,
                    help="also write the full per-blob record here")
    ap.add_argument("--from-full", default=None,
                    help="reuse an existing full run instead of recompiling")
    args = ap.parse_args()

    if args.from_full:
        with open(args.from_full, "r", encoding="utf-8") as fh:
            prior = json.load(fh)
        compact = _compact(prior["blobs"])
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(compact, fh, ensure_ascii=False, indent=1)
        print("recompacted from", args.from_full, "->", args.out)
        print("blobs:", compact["blobTotal"], "pass:", compact["blobPass"])
        return

    os.makedirs(args.tmp, exist_ok=True)
    deadline = time.time() + GLOBAL_DEADLINE_S

    blob_records = []

    files = sorted(
        f for f in glob.glob(os.path.join(args.bench_dir, "*.json"))
        if not f.endswith("summary.json")
    )
    for path in files:
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
        case_id = bytes.fromhex(
            os.path.basename(path)[: -len(".json")]
        ).decode("utf-8", "replace")
        for idx, fn in enumerate(doc.get("functions", [])):
            pc = fn.get("pseudocode")
            if pc is None:
                continue
            if time.time() > deadline:
                blob_records.append(
                    {"caseId": case_id, "index": idx, "skipped": "global-deadline"}
                )
                continue
            src = pc if pc.endswith("\n") else pc + "\n"
            path_c = os.path.join(args.tmp, "blob.c")
            with open(path_c, "w", encoding="utf-8") as fh:
                fh.write(src)
            try:
                p = subprocess.run(
                    [args.clang, "-std=gnu11", "-fsyntax-only", "-ferror-limit=0", path_c],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    timeout=PER_CASE_TIMEOUT_S,
                )
                code, err = p.returncode, p.stderr.decode("utf-8", "replace")
            except subprocess.TimeoutExpired:
                blob_records.append(
                    {
                        "caseId": case_id,
                        "index": idx,
                        "name": fn.get("name"),
                        "address": fn.get("address"),
                        "state": fn.get("state"),
                        "pass": None,
                        "timedOut": True,
                        "firstError": None,
                        "sourceLine": None,
                    }
                )
                continue
            passed = code == 0
            first = None
            if not passed and err:
                for line in err.splitlines():
                    m = re.match(r"^.+?:(\d+):(\d+): (error|fatal error): (.*)$", line)
                    if m:
                        first = {
                            "line": int(m.group(1)),
                            "col": int(m.group(2)),
                            "message": m.group(4),
                        }
                        break
            source_line = _line_text(src, first)
            blob_records.append(
                {
                    "caseId": case_id,
                    "index": idx,
                    "name": fn.get("name"),
                    "address": fn.get("address"),
                    "state": fn.get("state"),
                    "pass": passed,
                    "firstError": first,
                    "sourceLine": source_line,
                    "timedOut": False,
                    "fallbackLink": None,
                }
            )

    result = _compact(blob_records)

    if args.full:
        with open(args.full, "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "schema": "hex-direct-recompilability-single-function-probe/full/v2",
                    "summary": {k: v for k, v in result.items()
                                if k not in ("perCase", "failingBlobSamples")},
                    "blobs": blob_records,
                },
                fh, ensure_ascii=False, indent=1,
            )
        print("full record written to", args.full)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=1)

    print(
        "candidates:", result["blobCandidates"],
        "attempted:", result["blobAttempted"],
        "completed:", result["blobCompleted"],
        "pass:", result["blobPass"],
        "fail:", result["blobFail"],
        "skipped:", result["blobSkipped"],
        "timed out:", result["blobTimedOut"],
    )
    print("cases with >=1 passing blob:", result["casesWithAtLeastOnePassingBlob"], "/", result["caseCount"])
    print("top first-error families:")
    for k, v in collections.Counter(result["failFamilies"]).most_common(10):
        print(f"  {v:6d}  {k}")
    print("top first-error clusters:")
    for k, v in collections.Counter(result["failClusters"]).most_common(12):
        print(f"  {v:6d}  {k}")


if __name__ == "__main__":
    main()
