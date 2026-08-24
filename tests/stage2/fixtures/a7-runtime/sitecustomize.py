"""A7-only launcher bridge for LLDB's embedded Python runtime.

The Ubuntu/Debian LLDB package can expose a Python wrapper that external
``python3`` cannot import because the native ``_lldb`` binding is packaged
separately.  The A7 proof runners already invoke only generated, bounded
provider scripts from temporary ``hex-a7-*`` directories.  For exactly those
scripts, replace the external Python process with the installed LLDB driver
and import the same script in LLDB's embedded interpreter, where ``_lldb`` is
registered by LLDB itself.

This file never fabricates debugger results and never runs for arbitrary
repository Python.  It only selects the installed provider's supported Python
entry path before the proof script executes.
"""
from __future__ import annotations

import os
import shutil
import sys


def _is_a7_provider_script(pathname: str) -> bool:
    if not pathname:
        return False
    resolved = os.path.realpath(pathname)
    base = os.path.basename(resolved)
    parent = os.path.basename(os.path.dirname(resolved))
    return (
        base.endswith(".py")
        and (base == "a7-lldb-active-ops.py" or base.startswith("a7-cross-active-"))
        and (parent.startswith("hex-a7-x86-") or parent.startswith("hex-a7-cross-"))
    )


def _handoff_to_embedded_lldb() -> None:
    script = sys.argv[0] if sys.argv else ""
    if not _is_a7_provider_script(script):
        return

    lldb = os.environ.get("LLDB") or shutil.which("lldb") or shutil.which("lldb-18")
    if not lldb:
        raise RuntimeError("a7-lldb-driver-unavailable")
    lldb = os.path.realpath(lldb)
    if os.path.basename(lldb) not in {"lldb", "lldb-18"}:
        raise RuntimeError(f"a7-lldb-driver-untrusted:{lldb}")

    script = os.path.realpath(script)
    env = os.environ.copy()
    # The embedded interpreter obtains its Python paths from LLDB itself.
    # Do not carry the external-wrapper PYTHONPATH into the embedded runtime.
    env.pop("PYTHONPATH", None)
    argv = [
        lldb,
        "-b",
        "-Q",
        "-o",
        "settings set symbols.enable-external-lookup false",
        "-o",
        f"command script import {script}",
        "-o",
        "quit",
    ]
    os.execve(lldb, argv, env)


_handoff_to_embedded_lldb()
