#!/usr/bin/env python3
"""Direct-recompilability investigation: Stage 1 exact baseline.

Reads the FROZEN, read-only public-benchmark artifacts, deterministically
reconstructs one C translation unit per case from the saved Hex pseudocode,
and compiles it with the host clang.

Hard rules (investigation contract):
  * No source repair. No typedef / prototype / extern / stub additions, no
    renames, no variable repair, no syntax rewrites. The emitted diagnostic
    source is the raw pseudocode concatenation, byte for byte.
  * Diagnostic sources are written under /tmp and are never committed.
  * Per-case timeout 10 s, plus a finite global deadline for the whole run.

Usage:
  python3 run-baseline.py --bench-dir <dir> --out-dir <tmpdir> [--only CASEID]

Outputs (under --out-dir):
  src/<slug>.c          raw reconstructed translation unit (diagnostic only)
  raw/<slug>.json       raw per-case compile record (diagnostics, line map)
  sources-index.json    case -> source path / line map
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time

PER_CASE_TIMEOUT_S = 10.0
GLOBAL_DEADLINE_S = 900.0

DIAG_RE = re.compile(
    r"^(?P<file>.+?):(?P<line>\d+):(?P<col>\d+):\s+"
    r"(?P<severity>fatal error|error|warning|note):\s+(?P<message>.*)$"
)


def slug(case_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", case_id)


def decode_case_id(fname: str) -> str:
    base = fname[: -len(".json")]
    try:
        return bytes.fromhex(base).decode("utf-8")
    except Exception:
        return base


def load_functions(path: str):
    with open(path, "r", encoding="utf-8") as fh:
        doc = json.load(fh)
    return doc


def reconstruct(doc):
    """Deterministically rebuild the raw translation unit.

    Rule: walk `functions` in stored array order; keep only entries whose
    `pseudocode` is a non-null string; join with a single "\n"; terminate with
    one "\n".  Nothing else is inserted.
    """
    parts = []
    line_map = []
    cursor_line = 1
    for fn in doc.get("functions", []):
        pc = fn.get("pseudocode")
        if pc is None:
            continue
        if parts:
            # join(parts) inserts exactly one separator before this blob.
            cursor_line += 1
        start = cursor_line
        logical_lines = max(1, pc.count("\n") + (0 if pc.endswith("\n") else 1))
        end = start + logical_lines - 1
        line_map.append(
            {
                "name": fn.get("name"),
                "address": fn.get("address"),
                "state": fn.get("state"),
                "completeness": fn.get("completeness"),
                "startLine": start,
                "endLine": end,
            }
        )
        parts.append(pc)
        cursor_line += pc.count("\n")
    source = "\n".join(parts)
    if source:
        source += "\n"
    return source, line_map


SUMMARY_RE = re.compile(r"^\d+ warnings? and \d+ errors? generated\.$")


def parse_diagnostics(text: str):
    out = []
    for raw in text.splitlines():
        if SUMMARY_RE.match(raw.strip()):
            # clang's final tally line is a summary, not a diagnostic.
            continue
        m = DIAG_RE.match(raw)
        if m:
            out.append(
                {
                    "severity": m.group("severity"),
                    "line": int(m.group("line")),
                    "col": int(m.group("col")),
                    "message": m.group("message"),
                    "raw": raw,
                }
            )
        elif raw.strip() and ("error" in raw.lower() or "undefined reference" in raw):
            out.append(
                {
                    "severity": "linker/other",
                    "line": None,
                    "col": None,
                    "message": raw.strip(),
                    "raw": raw,
                }
            )
    return out


def run(cmd, timeout):
    t0 = time.time()
    try:
        p = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
        return {
            "exitCode": p.returncode,
            "timedOut": False,
            "stdout": p.stdout.decode("utf-8", "replace"),
            "stderr": p.stderr.decode("utf-8", "replace"),
            "seconds": round(time.time() - t0, 3),
        }
    except subprocess.TimeoutExpired as e:
        return {
            "exitCode": None,
            "timedOut": True,
            "stdout": (e.stdout or b"").decode("utf-8", "replace"),
            "stderr": (e.stderr or b"").decode("utf-8", "replace"),
            "seconds": round(time.time() - t0, 3),
        }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bench-dir", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--clang", default="clang")
    ap.add_argument("--only", default=None)
    args = ap.parse_args()

    bench = os.path.abspath(args.bench_dir)
    out = os.path.abspath(args.out_dir)
    src_dir = os.path.join(out, "src")
    raw_dir = os.path.join(out, "raw")
    os.makedirs(src_dir, exist_ok=True)
    os.makedirs(raw_dir, exist_ok=True)

    version = run([args.clang, "--version"], 10)
    compiler_version = (version["stdout"] or version["stderr"]).strip()

    case_files = sorted(
        f for f in os.listdir(bench) if f.endswith(".json") and f != "summary.json"
    )

    index = {"compiler": args.clang, "compilerVersion": compiler_version, "cases": []}
    deadline = time.time() + GLOBAL_DEADLINE_S
    started = time.time()

    for fname in case_files:
        case_id = decode_case_id(fname)
        if args.only and case_id != args.only:
            continue
        s = slug(case_id)
        if time.time() > deadline:
            index["cases"].append({"caseId": case_id, "skipped": "global-deadline"})
            continue

        doc = load_functions(os.path.join(bench, fname))
        source, line_map = reconstruct(doc)
        src_path = os.path.join(src_dir, s + ".c")
        with open(src_path, "w", encoding="utf-8") as fh:
            fh.write(source)
        src_sha = hashlib.sha256(source.encode("utf-8")).hexdigest()

        syntax_cmd = [
            args.clang,
            "-std=gnu11",
            "-fsyntax-only",
            "-ferror-limit=0",
            src_path,
        ]
        syntax = run(syntax_cmd, PER_CASE_TIMEOUT_S)

        rec = {
            "caseId": case_id,
            "artifactFile": fname,
            "inputSha256": doc.get("inputSha256"),
            "artifactSchema": doc.get("schema"),
            "artifactState": doc.get("state"),
            "functionStateCounts": doc.get("functionStateCounts"),
            "sourceFile": src_path,
            "sourceSha256": src_sha,
            "sourceBytes": len(source),
            "sourceLineCount": source.count("\n"),
            "pseudocodeFunctionCount": len(line_map),
            "lineMap": line_map,
            "syntax": {
                "command": syntax_cmd,
                "exitCode": syntax["exitCode"],
                "timedOut": syntax["timedOut"],
                "seconds": syntax["seconds"],
                "diagnostics": parse_diagnostics(syntax["stderr"]),
                "diagnosticTruncated": "too many errors emitted" in syntax["stderr"],
                "stderr": syntax["stderr"][:200000],
            },
            "link": {"attempted": False},
        }

        syntax_pass = syntax["exitCode"] == 0 and not syntax["timedOut"]
        if syntax_pass and time.time() < deadline:
            exe = os.path.join(out, "bin", s + ".out")
            os.makedirs(os.path.dirname(exe), exist_ok=True)
            link_cmd = [
                args.clang,
                "-std=gnu11",
                "-O0",
                "-ferror-limit=0",
                src_path,
                "-o",
                exe,
            ]
            link = run(link_cmd, PER_CASE_TIMEOUT_S)
            rec["link"] = {
                "attempted": True,
                "command": link_cmd,
                "exitCode": link["exitCode"],
                "timedOut": link["timedOut"],
                "seconds": link["seconds"],
                "diagnostics": parse_diagnostics(link["stderr"]),
                "stderr": link["stderr"][:200000],
            }
        else:
            rec["link"] = {
                "attempted": False,
                "skippedReason": "syntax-stage-failed" if not syntax["timedOut"] else "syntax-timeout",
            }

        with open(os.path.join(raw_dir, s + ".json"), "w", encoding="utf-8") as fh:
            json.dump(rec, fh, ensure_ascii=False, indent=1)

        index["cases"].append(
            {
                "caseId": case_id,
                "sourceFile": src_path,
                "sourceSha256": src_sha,
                "sourceBytes": len(source),
                "syntaxPass": syntax_pass,
                "linkPass": rec["link"].get("exitCode") == 0 and not rec["link"].get("timedOut"),
            }
        )
        print(
            "%-28s syntax=%-5s link=%s  diags=%d"
            % (
                case_id,
                syntax_pass,
                rec["link"].get("exitCode"),
                len(rec["syntax"]["diagnostics"]),
            ),
            flush=True,
        )

    index["elapsedSeconds"] = round(time.time() - started, 2)
    with open(os.path.join(out, "sources-index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, indent=1)
    print("DONE", file=sys.stderr)


if __name__ == "__main__":
    main()
