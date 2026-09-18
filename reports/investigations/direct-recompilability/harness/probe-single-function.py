#!/usr/bin/env python3
"""Stage 3 focused probe: single-function recompilability.

Stage 1 compiled the *concatenation* of every function in a case, which mixes
two different questions:

  (a) is a function's own emitted text a valid C function definition?  and
  (b) is there a standalone translation unit around it?

This probe answers (a) alone: one pseudocode blob per translation unit, nothing
added, nothing repaired. If a blob still fails, the defect is intra-function and
therefore a genuine emitter defect rather than a missing prelude.

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


def _per_case(blobs):
    per = collections.defaultdict(lambda: {"blobs": 0, "pass": 0})
    for b in blobs:
        if b.get("skipped"):
            continue
        per[b["caseId"]]["blobs"] += 1
        if b["pass"]:
            per[b["caseId"]]["pass"] += 1
    return {k: per[k] for k in sorted(per)}


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
        compact = {k: v for k, v in prior.items() if k != "blobs"}
        compact["perCase"] = _per_case(prior["blobs"])
        compact["failingBlobSamples"] = [
            b for b in prior["blobs"] if not b.get("pass")
        ][:200]
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(compact, fh, ensure_ascii=False, indent=1)
        print("recompacted from", args.from_full, "->", args.out)
        print("blobs:", compact["blobTotal"], "pass:", compact["blobPass"])
        return

    os.makedirs(args.tmp, exist_ok=True)
    deadline = time.time() + GLOBAL_DEADLINE_S

    blob_total = 0
    blob_pass = 0
    fail_families = collections.Counter()
    fail_clusters = collections.Counter()
    case_pass = collections.Counter()   # caseId -> blobs that pass
    case_total = collections.Counter()
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
            blob_total += 1
            case_total[case_id] += 1
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
                code, err = None, ""
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
            if passed:
                blob_pass += 1
                case_pass[case_id] += 1
            if first:
                fail_families[norm_family(first["message"])] += 1
                fail_clusters[cluster_of({"severity": "error", **first})] += 1
            blob_records.append(
                {
                    "caseId": case_id,
                    "index": idx,
                    "name": fn.get("name"),
                    "address": fn.get("address"),
                    "state": fn.get("state"),
                    "pass": passed,
                    "firstError": first,
                    "fallbackLink": None if passed else None,
                }
            )

    if args.full:
        with open(args.full, "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "schema": "hex-direct-recompilability-single-function-probe/full/v1",
                    "blobTotal": blob_total, "blobPass": blob_pass,
                    "blobs": blob_records,
                },
                fh, ensure_ascii=False, indent=1,
            )
        print("full record written to", args.full)

    result = {
        "schema": "hex-direct-recompilability-single-function-probe/v1",
        "note": (
            "Each pseudocode blob compiled alone as its own translation unit, "
            "no prelude and no repair. Answers intra-function validity only."
        ),
        "blobTotal": blob_total,
        "blobPass": blob_pass,
        "blobFail": blob_total - blob_pass,
        "failFamilies": dict(fail_families.most_common(20)),
        "failClusters": dict(fail_clusters.most_common(20)),
        "casesWithAtLeastOnePassingBlob": sum(1 for k, v in case_pass.items() if v > 0),
        "caseCount": len(case_total),
        "perCase": {
            cid: {"blobs": case_total[cid], "pass": case_pass.get(cid, 0)}
            for cid in sorted(case_total)
        },
        "failingBlobSamples": [b for b in blob_records if not b.get("pass")][:200],
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=1)

    print("blobs:", blob_total, "pass:", blob_pass, "fail:", blob_total - blob_pass)
    print("cases with >=1 passing blob:", result["casesWithAtLeastOnePassingBlob"], "/", len(case_total))
    print("top first-error families:")
    for k, v in fail_families.most_common(10):
        print(f"  {v:6d}  {k}")
    print("top first-error clusters:")
    for k, v in fail_clusters.most_common(12):
        print(f"  {v:6d}  {k}")


if __name__ == "__main__":
    main()
