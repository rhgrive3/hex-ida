#!/usr/bin/env python3
"""Neutral control for the direct-recompilability study.

Applies the *identical* compiler rules used for the Hex baseline to the IDA Pro
9.1 / Hex-Rays reference `.c` artifacts that ship with the same frozen corpus.

This exists so the 0/160 Hex result is interpretable: if the reference output
also fails the same stage, then "raw decompiler text is not a standalone
translation unit" is a property of the tool class, not a Hex-specific defect.

Explicitly NOT a quality or superiority comparison: the reference is
program-scoped output using a different (MSVC/IDA) type vocabulary, and this
script performs no semantic check of any kind.
"""

import argparse
import collections
import glob
import json
import os
import re
import subprocess

CMD = ["clang", "-std=gnu11", "-fsyntax-only", "-ferror-limit=0"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference-dir", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    refs = sorted(glob.glob(os.path.join(args.reference_dir, "*", "*.c")))
    fams = collections.Counter()
    errcounts = collections.Counter()
    detail = []
    for path in refs:
        p = subprocess.run(
            CMD + [path], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20
        )
        err = p.stderr.decode("utf-8", "replace")
        msgs = [
            re.sub(r"'[^']*'", "'X'", m)
            for m in re.findall(r": (?:error|fatal error): (.*)$", err, re.M)
        ]
        for m in set(msgs):
            fams[m] += 1
        errcounts[len(msgs)] += 1
        detail.append(
            {
                "ref": os.path.relpath(path, args.reference_dir),
                "exitCode": p.returncode,
                "errorCount": len(msgs),
                "errorFamilies": sorted(set(msgs)),
            }
        )

    doc = {
        "schema": "hex-direct-recompilability-reference-control/v1",
        "note": (
            "Identical compiler rules applied to the IDA Pro 9.1 Hex-Rays "
            "reference .c artifacts shipped with the same corpus. Not a quality "
            "or superiority comparison; no semantic check is performed."
        ),
        "compilerCommand": CMD,
        "files": len(refs),
        "syntaxPass": sum(1 for d in detail if d["exitCode"] == 0),
        "errorCountDistribution": {str(k): v for k, v in sorted(errcounts.items())},
        "errorFamiliesByFileCount": dict(fams.most_common()),
        "detail": detail,
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)

    print("reference files:", len(refs))
    print("syntax pass:", doc["syntaxPass"], "/", len(refs))
    for k, v in list(fams.most_common(8)):
        print(f"  {v:4d}  {k}")


if __name__ == "__main__":
    main()
