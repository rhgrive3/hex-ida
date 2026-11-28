#!/usr/bin/env python3
"""Zero-cheat differential semantic equivalence gate comparing Hex vs IDA 9.1 C output.

CLI:
  python3 -I tools/validation/public-benchmark/ida-differential.py <pb_output_dir> <out_json> [case_filter] [--gate] [--max-mismatches N]
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_BENCH_DIR = REPO_ROOT / "benchmarks" / "public" / "codefuse-arm64"

IDA_FUNC_RE = re.compile(r"/\*\s*Function:\s*(.*?)\s*@\s*(0x[0-9A-Fa-f]+)\s*\*/")

# 18 deterministic test values covering zero, small/negative, powers of two, and INT32_MAX.
TEST_VALS = [
    0, 1, -1, 2, 3, 4, 5, 7, 8, 10, 15, 16, 42, 100, -100, 255, 1024, 0x7FFFFFFF
]

INT32_BASE_TYPES = {
    "int", "int32_t", "uint32_t", "int32", "uint32", "__int32", "_DWORD", "DWORD",
    "short", "int16_t", "uint16_t", "int16", "uint16", "__int16", "_WORD", "WORD",
    "char", "int8_t", "uint8_t", "int8", "uint8", "__int8", "_BYTE", "BYTE",
    "bool", "_Bool", "_BOOL1", "_BOOL2", "_BOOL4",
}

INT64_BASE_TYPES = {
    "__int64", "int64_t", "uint64_t", "uint64", "int64",
    "_QWORD", "QWORD", "_BOOL8", "long", "size_t", "ssize_t",
    "intptr_t", "uintptr_t", "ptrdiff_t",
}

IGNORED_QUALIFIERS = {
    "__cdecl", "__fastcall", "__stdcall", "__usercall", "__thiscall",
    "__noreturn", "__hidden", "__spoils", "const", "volatile", "register",
    "signed", "unsigned", "extern", "inline", "__inline", "__inline__",
}

DISALLOWED_TYPE_TOKENS = {
    "void", "float", "double", "struct", "union", "enum",
    "__int128", "uint128", "vector128", "id",
}

IDA_PREAMBLE = r"""
#define _GNU_SOURCE
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <math.h>
#include <ctype.h>
#include <limits.h>

typedef int64_t __int64;
typedef int32_t __int32;
typedef int16_t __int16;
typedef int8_t __int8;
typedef uint8_t _BYTE;
typedef uint16_t _WORD;
typedef uint32_t _DWORD;
typedef uint64_t _QWORD;
typedef uint8_t BYTE;
typedef uint16_t WORD;
typedef uint32_t DWORD;
typedef uint64_t QWORD;
typedef uint8_t _BOOL1;
typedef uint16_t _BOOL2;
typedef uint32_t _BOOL4;
typedef uint64_t _BOOL8;
typedef unsigned __int128 _OWORD;
typedef unsigned __int128 __int128_u;

#define __cdecl
#define __fastcall
#define __stdcall
#define __usercall
#define __thiscall
#define __noreturn
#define __hidden
#define __spoils

#define LODWORD(x) ((uint32_t)((uint64_t)(x) & 0xFFFFFFFFULL))
#define HIDWORD(x) ((uint32_t)(((uint64_t)(x) >> 32) & 0xFFFFFFFFULL))
#define LOWORD(x) ((uint16_t)((uint64_t)(x) & 0xFFFFULL))
#define HIWORD(x) ((uint16_t)(((uint64_t)(x) >> 16) & 0xFFFFULL))
#define LOBYTE(x) ((uint8_t)((uint64_t)(x) & 0xFFULL))
#define HIBYTE(x) ((uint8_t)(((uint64_t)(x) >> 8) & 0xFFULL))
#define SLODWORD(x) ((int32_t)LODWORD(x))
#define SHIDWORD(x) ((int32_t)HIDWORD(x))
#define SLOWORD(x) ((int16_t)LOWORD(x))
#define SHIWORD(x) ((int16_t)HIWORD(x))
#define SLOBYTE(x) ((int8_t)LOBYTE(x))
#define SHIBYTE(x) ((int8_t)HIBYTE(x))
#define __PAIR64__(hi, lo) (((uint64_t)(uint32_t)(hi) << 32) | (uint32_t)(lo))
#define __PAIR32__(hi, lo) (((uint32_t)(uint16_t)(hi) << 16) | (uint32_t)(lo))
#define __ROR4__(x, n) (((uint32_t)(x) >> ((n) & 31)) | ((uint32_t)(x) << ((32 - ((n) & 31)) & 31)))
#define __ROL4__(x, n) (((uint32_t)(x) << ((n) & 31)) | ((uint32_t)(x) >> ((32 - ((n) & 31)) & 31)))
#define __ROR8__(x, n) (((uint64_t)(x) >> ((n) & 63)) | ((uint64_t)(x) << ((64 - ((n) & 63)) & 63)))
#define __ROL8__(x, n) (((uint64_t)(x) << ((n) & 63)) | ((uint64_t)(x) >> ((64 - ((n) & 63)) & 63)))
#define COERCE_FLOAT(v) ({ uint32_t _t = (uint32_t)(v); float _f; memcpy(&_f, &_t, 4); _f; })
#define COERCE_DOUBLE(v) ({ uint64_t _t = (uint64_t)(v); double _d; memcpy(&_d, &_t, 8); _d; })
static inline int __hex_ofsub64(int64_t a, int64_t b) { int64_t r; return __builtin_sub_overflow(a, b, &r); }
#define __OFSUB__(x, y) __hex_ofsub64((int64_t)(x), (int64_t)(y))
#define __OFADD__(x, y) (((int64_t)(x) > 0 && (int64_t)(y) > INT64_MAX - (int64_t)(x)) || ((int64_t)(x) < 0 && (int64_t)(y) < INT64_MIN - (int64_t)(x)))
"""

HEX_PREAMBLE = r"""
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <math.h>
#include <ctype.h>
#include <limits.h>
#ifndef __HEX_ANY_ARGS
#define __HEX_ANY_ARGS ...
#endif
"""


def parse_ida_functions(source: str) -> dict:
    """Parse IDA 9.1 reference .c file into {address_int: {name, address, pseudocode}}."""
    matches = list(IDA_FUNC_RE.finditer(source))
    out = {}
    for idx, m in enumerate(matches):
        name = m.group(1).strip()
        addr = int(m.group(2), 16)
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(source)
        body = source[m.end():end].strip()
        out[addr] = {"name": name, "address": addr, "pseudocode": body}
    return out


def strip_c_comments(code: str) -> str:
    """Remove C block and line comments for signature parsing."""
    code = re.sub(r"/\*.*?\*/", " ", code, flags=re.S)
    code = re.sub(r"//[^\n]*", " ", code)
    return code


def classify_int_type(type_str: str):
    """Return ('int32' | 'int64' | None) for a C type string."""
    s = type_str.strip()
    if not s:
        return None
    if any(ch in s for ch in ("*", "[", "]", "(", ")", "{", "}", "...")):
        return None
    tokens = re.findall(r"[A-Za-z_][A-Za-z0-9_]*", s)
    if not tokens:
        return None
    if any(t in DISALLOWED_TYPE_TOKENS for t in tokens):
        return None
    # Handle `long long`, `unsigned long`, `unsigned`, `signed`
    core = [t for t in tokens if t not in IGNORED_QUALIFIERS]
    if not core:
        # Bare `unsigned` or `signed` means 32-bit int in C.
        if "unsigned" in tokens or "signed" in tokens:
            return "int32"
        return None
    if "long" in core:
        return "int64"
    if any(t in INT64_BASE_TYPES for t in core):
        return "int64"
    if all(t in INT32_BASE_TYPES for t in core):
        return "int32"
    return None


def parse_params(params_str: str):
    """Parse C parameter list; return list of ('int32'|'int64') or None if unsupported."""
    s = params_str.strip()
    if not s or s == "void":
        return []
    if "..." in s or "(*" in s:
        return None
    parts = [p.strip() for p in s.split(",")]
    if len(parts) > 4:
        return None
    result = []
    for p in parts:
        if not p:
            return None
        if any(ch in p for ch in ("*", "[", "]", "(", ")", "...")):
            return None
        # Strip trailing parameter identifier if present (unless single-token type like `int`)
        tokens = re.findall(r"[A-Za-z_][A-Za-z0-9_]*", p)
        if not tokens:
            return None
        # Try full token list as type first; if not a pure type, drop the trailing param name
        t_full = classify_int_type(" ".join(tokens))
        if t_full is not None and len(tokens) == 1:
            result.append(t_full)
            continue
        if len(tokens) >= 2:
            t_no_name = classify_int_type(" ".join(tokens[:-1]))
            if t_no_name is not None:
                result.append(t_no_name)
                continue
        if t_full is not None:
            result.append(t_full)
            continue
        return None
    return result


def parse_ida_signature(code: str):
    """Extract (ret_width, func_name, param_widths, raw_sig) from IDA function C."""
    cleaned = strip_c_comments(code)
    brace = cleaned.find("{")
    if brace < 0:
        return None
    header = " ".join(cleaned[:brace].split())
    m = re.match(r"^(.*?)\b([A-Za-z_][A-Za-z0-9_]*)\s*\(([^()]*)\)\s*$", header)
    if not m:
        return None
    ret_str, func_name, params_str = m.group(1).strip(), m.group(2).strip(), m.group(3).strip()
    ret_width = classify_int_type(ret_str)
    if ret_width is None:
        return None
    params = parse_params(params_str)
    if params is None:
        return None
    return {
        "retWidth": ret_width,
        "name": func_name,
        "params": params,
        "raw": header,
    }


def parse_hex_signature(code: str):
    """Extract (ret_width, func_name, param_widths, raw_sig) of the primary non-static function in Hex C."""
    lines = code.splitlines()
    depth = 0
    candidates = []
    buf = []
    for line in lines:
        stripped = line.strip()
        if depth == 0:
            if not stripped or stripped.startswith("#") or stripped.startswith("//") or stripped.startswith("/*"):
                buf = []
                continue
            if stripped.startswith("typedef ") or stripped.startswith("extern "):
                buf = []
                continue
        buf.append(line)
        # Update brace depth ignoring string literals loosely
        open_b = line.count("{")
        close_b = line.count("}")
        if depth == 0 and open_b > 0:
            joined = " ".join(strip_c_comments(" ".join(buf)).split())
            before_brace = joined.split("{", 1)[0].strip()
            m = re.match(r"^(.*?)\b([A-Za-z_][A-Za-z0-9_]*)\s*\(([^()]*)\)\s*$", before_brace)
            if m:
                ret_str = m.group(1).strip()
                fname = m.group(2).strip()
                params_str = m.group(3).strip()
                is_static = bool(re.search(r"\bstatic\b", ret_str))
                candidates.append((is_static, ret_str, fname, params_str, before_brace))
            buf = []
        depth += open_b - close_b
        if depth < 0:
            depth = 0
        if depth == 0 and stripped.endswith(";"):
            buf = []

    non_static = [c for c in candidates if not c[0]]
    chosen = non_static[-1] if non_static else (candidates[-1] if candidates else None)
    if chosen is None:
        return None
    _, ret_str, fname, params_str, before_brace = chosen
    ret_width = classify_int_type(ret_str)
    if ret_width is None:
        return None
    params = parse_params(params_str)
    if params is None:
        return None
    return {
        "retWidth": ret_width,
        "name": fname,
        "params": params,
        "raw": before_brace,
    }


def build_test_vectors(arity: int) -> list:
    """Return deterministic test input tuples for arity in 0..4."""
    n = len(TEST_VALS)
    if arity == 0:
        return [()]
    if arity == 1:
        return [(v,) for v in TEST_VALS]
    vectors = []
    # Include diagonal boundary cases first, then deterministic coprime strides.
    for i in range(n):
        if i < 3:
            v = TEST_VALS[i]
            vectors.append(tuple(v for _ in range(arity)))
        else:
            row = []
            for p in range(arity):
                idx = (i * (1 + 2 * p) + p * 5) % n
                row.append(TEST_VALS[idx])
            vectors.append(tuple(row))
    return vectors


def build_driver_source(code: str, sig: dict, vectors: list, is_ida: bool) -> str:
    """Wrap decompiled C function with a self-contained test driver."""
    func_name = sig["name"]
    arity = len(sig["params"])
    rename_main = func_name == "main"
    call_name = "__hex_diff_target_main" if rename_main else func_name

    parts = []
    if is_ida:
        parts.append(IDA_PREAMBLE)
    else:
        parts.append(HEX_PREAMBLE)
        for alias, std in (("uint64", "uint64_t"), ("int64", "int64_t"), ("uint32", "uint32_t"), ("int32", "int32_t"), ("uint16", "uint16_t"), ("int16", "int16_t"), ("uint8", "uint8_t"), ("int8", "int8_t")):
            if re.search(rf"\b{alias}\b", code) and not re.search(rf"\btypedef\b[^\n;]*\b{alias}\s*;", code):
                parts.append(f"typedef {std} {alias};\n")

    if rename_main:
        parts.append("#define main __hex_diff_target_main\n")
    parts.append(code)
    parts.append("\n")
    if rename_main:
        parts.append("#undef main\n")

    parts.append("int main(void) {\n")
    for idx, vec in enumerate(vectors):
        arg_exprs = []
        for p_idx in range(arity):
            val = vec[p_idx]
            if sig["params"][p_idx] == "int32":
                arg_exprs.append(f"(int32_t)({val}LL)")
            else:
                arg_exprs.append(f"(int64_t)({val}LL)")
        args_str = ", ".join(arg_exprs)
        parts.append(
            f'    printf("R {idx} %016llx\\n", (unsigned long long)(uint64_t)({call_name}({args_str})));\n'
        )
    parts.append("    return 0;\n}\n")
    return "".join(parts)


def compile_c(src: str, workdir: Path, tag: str):
    """Compile C source with gcc -O0 -w -x c (5s timeout). Return (bin_path, status, stderr)."""
    src_path = workdir / f"{tag}.c"
    bin_path = workdir / f"{tag}.bin"
    src_path.write_text(src, encoding="utf-8")
    try:
        proc = subprocess.run(
            ["gcc", "-O0", "-w", "-x", "c", str(src_path), "-o", str(bin_path), "-lm"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except subprocess.TimeoutExpired:
        return None, "compile_timeout", "gcc compile timeout"
    if proc.returncode != 0:
        err = proc.stderr or ""
        if "undefined reference to" in err and not re.search(r":\d+:\d+:\s*error:", err):
            return None, "unresolved_link", err[-500:]
        return None, "compile_error", err[-500:]
    return bin_path, "ok", ""


def run_binary(bin_path: Path, expected_count: int):
    """Run compiled binary (2s timeout) and parse `R <idx> <hex64>` outputs."""
    try:
        proc = subprocess.run(
            [str(bin_path)],
            capture_output=True,
            text=True,
            timeout=2,
        )
    except subprocess.TimeoutExpired:
        return None, "timeout"
    if proc.returncode != 0:
        return None, f"exit_{proc.returncode}"
    results = []
    for line in proc.stdout.splitlines():
        if line.startswith("R "):
            parts = line.split()
            if len(parts) == 3:
                try:
                    results.append(int(parts[2], 16))
                except ValueError:
                    return None, "parse_error"
    if len(results) != expected_count:
        return None, f"count_mismatch_{len(results)}_vs_{expected_count}"
    return results, "ok"


def evaluate_function(case_id: str, addr: int, ida_fn: dict, hex_fn: dict, workdir: Path) -> dict:
    """Compile, run, and compare one matched function pair."""
    addr_hex = f"0x{addr:x}"
    name = ida_fn["name"] or hex_fn.get("name") or f"sub_{addr:x}"
    hex_code = hex_fn.get("pseudocode") or ""
    ida_code = ida_fn.get("pseudocode") or ""

    if not hex_code.strip() or not ida_code.strip():
        return {
            "address": addr_hex,
            "name": name,
            "status": "skipped_signature",
            "reason": "empty_pseudocode",
        }

    ida_sig = parse_ida_signature(ida_code)
    hex_sig = parse_hex_signature(hex_code)
    if ida_sig is None or hex_sig is None:
        return {
            "address": addr_hex,
            "name": name,
            "status": "skipped_signature",
            "reason": "unsupported_signature",
        }

    max_arity = max(len(ida_sig["params"]), len(hex_sig["params"]))
    vectors = build_test_vectors(max_arity)

    ida_src = build_driver_source(ida_code, ida_sig, vectors, is_ida=True)
    hex_src = build_driver_source(hex_code, hex_sig, vectors, is_ida=False)

    ida_bin, ida_cstatus, ida_cerr = compile_c(ida_src, workdir, f"ida_{addr:x}")
    if ida_cstatus == "unresolved_link":
        return {
            "address": addr_hex,
            "name": name,
            "status": "unresolved_link",
            "side": "ida",
            "detail": ida_cerr,
        }
    if ida_cstatus != "ok":
        return {
            "address": addr_hex,
            "name": name,
            "status": "uncompilable_ida",
            "detail": ida_cerr,
        }

    hex_bin, hex_cstatus, hex_cerr = compile_c(hex_src, workdir, f"hex_{addr:x}")
    if hex_cstatus == "unresolved_link":
        return {
            "address": addr_hex,
            "name": name,
            "status": "unresolved_link",
            "side": "hex",
            "detail": hex_cerr,
        }
    if hex_cstatus != "ok":
        return {
            "address": addr_hex,
            "name": name,
            "status": "uncompilable_hex",
            "detail": hex_cerr,
        }

    ida_vals, ida_rstatus = run_binary(ida_bin, len(vectors))
    if ida_rstatus != "ok":
        return {
            "address": addr_hex,
            "name": name,
            "status": "crash_or_timeout",
            "side": "ida",
            "detail": ida_rstatus,
        }

    hex_vals, hex_rstatus = run_binary(hex_bin, len(vectors))
    if hex_rstatus != "ok":
        return {
            "address": addr_hex,
            "name": name,
            "status": "crash_or_timeout",
            "side": "hex",
            "detail": hex_rstatus,
        }

    # Exact 64-bit comparison first.
    first_exact_diff = None
    for idx, (iv, hv) in enumerate(zip(ida_vals, hex_vals)):
        if iv != hv:
            first_exact_diff = (idx, vectors[idx], iv, hv)
            break

    if first_exact_diff is None:
        return {
            "address": addr_hex,
            "name": name,
            "status": "match",
            "width32Normalized": False,
            "tests": len(vectors),
        }

    # Honest 32-bit width normalization ONLY when one side has a 32-bit return type and the other has 64-bit.
    mixed_width = ida_sig["retWidth"] != hex_sig["retWidth"]
    if mixed_width:
        first_32_diff = None
        for idx, (iv, hv) in enumerate(zip(ida_vals, hex_vals)):
            if (iv & 0xFFFFFFFF) != (hv & 0xFFFFFFFF):
                first_32_diff = (idx, vectors[idx], iv, hv)
                break
        if first_32_diff is None:
            return {
                "address": addr_hex,
                "name": name,
                "status": "match",
                "width32Normalized": True,
                "tests": len(vectors),
            }
        diff_idx, diff_in, diff_ida, diff_hex = first_32_diff
    else:
        diff_idx, diff_in, diff_ida, diff_hex = first_exact_diff

    return {
        "address": addr_hex,
        "name": name,
        "status": "mismatch",
        "width32Normalized": False,
        "width32Checked": mixed_width,
        "caseId": case_id,
        "idaSignature": ida_sig["raw"],
        "hexSignature": hex_sig["raw"],
        "testIndex": diff_idx,
        "input": list(diff_in),
        "idaResult": f"0x{diff_ida:016x}",
        "hexResult": f"0x{diff_hex:016x}",
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Zero-cheat differential semantic equivalence gate (Hex vs IDA 9.1)"
    )
    parser.add_argument("pb_output_dir", help="Public benchmark output directory")
    parser.add_argument("out_json", help="Output JSON report path")
    parser.add_argument("case_filter", nargs="?", default=None, help="Optional case ID substring filter")
    parser.add_argument("--gate", action="store_true", help="Enable CI gate exit code")
    parser.add_argument("--max-mismatches", type=int, default=0, help="Max allowed mismatches in --gate mode")
    parser.add_argument("--manifest", default=None, help="Override path to manifest.json")
    args = parser.parse_intermixed_args(argv)

    pb_dir = Path(args.pb_output_dir).resolve()
    out_json = Path(args.out_json).resolve()
    manifest_path = Path(args.manifest).resolve() if args.manifest else (DEFAULT_BENCH_DIR / "manifest.json")
    suite_root = manifest_path.parent

    if not manifest_path.is_file():
        print(f"error: manifest not found: {manifest_path}", file=sys.stderr)
        return 2

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    cases_list = manifest.get("cases", [])

    counts = {
        "match": 0,
        "matchWidth32Normalized": 0,
        "mismatch": 0,
        "crash_or_timeout": 0,
        "hex_only_crashes": 0,
        "uncompilable_ida": 0,
        "uncompilable_hex": 0,
        "unresolved_link": 0,
        "skipped_signature": 0,
    }
    mismatches = []
    case_reports = []
    total_functions = 0

    exec_base = None
    for cand in (tempfile.gettempdir(), str(out_json.parent), str(REPO_ROOT)):
        try:
            Path(cand).mkdir(parents=True, exist_ok=True)
            probe_path = None
            try:
                with tempfile.NamedTemporaryFile(dir=cand, prefix=".hex_exec_probe_", delete=False) as f:
                    probe_path = f.name
                    f.write(b"#!/bin/sh\nexit 0\n")
                os.chmod(probe_path, 0o700)
                if subprocess.run([probe_path], capture_output=True, timeout=2).returncode == 0:
                    exec_base = cand
                    break
            finally:
                if probe_path and os.path.exists(probe_path):
                    try:
                        os.unlink(probe_path)
                    except OSError:
                        pass
        except Exception:
            continue

    with tempfile.TemporaryDirectory(prefix=".hex_ida_diff_", dir=exec_base) as tmp:
        workdir = Path(tmp)
        for entry in cases_list:
            case_id = entry["id"]
            if args.case_filter and args.case_filter not in case_id:
                continue
            hex_filename = case_id.encode("utf-8").hex() + ".json"
            hex_path = pb_dir / hex_filename
            if not hex_path.is_file():
                continue

            ref_rel = entry.get("reference", {}).get("path")
            if not ref_rel:
                continue
            ref_path = (suite_root / ref_rel).resolve()
            if not ref_path.is_file():
                continue

            hex_data = json.loads(hex_path.read_text(encoding="utf-8"))
            ida_funcs = parse_ida_functions(ref_path.read_text(encoding="utf-8"))

            hex_by_addr = {}
            for fn in hex_data.get("functions", []):
                raw_addr = fn.get("address")
                if raw_addr is None:
                    continue
                try:
                    addr_int = int(str(raw_addr), 0)
                except ValueError:
                    continue
                hex_by_addr[addr_int] = fn

            case_counts = {k: 0 for k in counts}
            case_funcs = []
            shared_addrs = sorted(set(ida_funcs.keys()) & set(hex_by_addr.keys()))
            for addr in shared_addrs:
                total_functions += 1
                res = evaluate_function(case_id, addr, ida_funcs[addr], hex_by_addr[addr], workdir)
                st = res["status"]
                counts[st] = counts.get(st, 0) + 1
                case_counts[st] = case_counts.get(st, 0) + 1
                if st == "crash_or_timeout" and res.get("side") == "hex":
                    counts["hex_only_crashes"] += 1
                    case_counts["hex_only_crashes"] += 1
                if st == "match" and res.get("width32Normalized"):
                    counts["matchWidth32Normalized"] += 1
                    case_counts["matchWidth32Normalized"] += 1
                if st == "mismatch":
                    mismatches.append(res)
                case_funcs.append(res)

            case_reports.append({
                "caseId": case_id,
                "matchedAddresses": len(shared_addrs),
                "counts": case_counts,
                "functions": case_funcs,
            })

    gate_reasons = []
    if counts["mismatch"] > args.max_mismatches:
        gate_reasons.append(f"mismatch_count ({counts['mismatch']}) > max_mismatches ({args.max_mismatches})")
    if counts["hex_only_crashes"] > 0:
        gate_reasons.append(f"hex_only_crashes ({counts['hex_only_crashes']}) > 0")
    if counts["uncompilable_hex"] > 5:
        gate_reasons.append(f"uncompilable_hex ({counts['uncompilable_hex']}) > 5")
    if counts["match"] == 0:
        gate_reasons.append("match_count == 0")
    gate_passed = len(gate_reasons) == 0

    report = {
        "schema": "hex-ida-differential/v1",
        "pbOutputDir": str(pb_dir),
        "caseFilter": args.case_filter,
        "casesProcessed": len(case_reports),
        "totalFunctions": total_functions,
        "counts": counts,
        "gate": {
            "enabled": bool(args.gate),
            "maxMismatches": args.max_mismatches,
            "hex_only_crashes": counts["hex_only_crashes"],
            "passed": gate_passed,
            "reasons": gate_reasons,
        },
        "mismatches": mismatches,
        "cases": case_reports,
    }

    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print(
        f"[ida-differential] cases={len(case_reports)} match={counts['match']} "
        f"(w32={counts['matchWidth32Normalized']}) mismatch={counts['mismatch']} "
        f"crash_or_timeout={counts['crash_or_timeout']} "
        f"hex_only_crashes={counts['hex_only_crashes']} "
        f"uncompilable_hex={counts['uncompilable_hex']} "
        f"uncompilable_ida={counts['uncompilable_ida']} "
        f"unresolved_link={counts['unresolved_link']} "
        f"skipped_signature={counts['skipped_signature']}"
    )
    if args.gate and not gate_passed:
        print(f"[ida-differential] GATE FAILED: {'; '.join(gate_reasons)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
