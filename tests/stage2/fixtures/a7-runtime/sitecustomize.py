"""A7-only launcher bridge for LLDB's embedded Python runtime.

The Ubuntu/Debian LLDB package can expose a Python wrapper that external
``python3`` cannot import because the native ``_lldb`` binding is packaged
separately. The A7 proof runners invoke only generated, bounded provider
scripts from temporary ``hex-a7-*`` directories. For exactly those scripts,
replace the external Python process with the installed LLDB driver and import
the same script in LLDB's embedded interpreter, where ``_lldb`` is registered
by LLDB itself.

This file never fabricates debugger results and never runs for arbitrary
repository Python. It only selects the installed provider's supported Python
entry path before the proof script executes.
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile


def _is_a7_provider_script(pathname: str) -> bool:
    if not pathname:
        return False
    resolved = os.path.realpath(pathname)
    directory = os.path.dirname(resolved)
    base = os.path.basename(resolved)
    parent = os.path.basename(directory)
    return (
        base.endswith(".py")
        and (base == "a7-lldb-active-ops.py" or base.startswith("a7-cross-active-"))
        and (parent.startswith("hex-a7-x86-") or parent.startswith("hex-a7-cross-"))
        and os.path.realpath(os.path.dirname(directory)) == os.path.realpath(tempfile.gettempdir())
    )


def _installed_lldb() -> str:
    # Match the A7 runner's provider selection order. Do not accept an
    # unrelated LLDB executable through environment substitution.
    for candidate in (
        "/usr/bin/lldb",
        "/usr/bin/lldb-18",
        "/usr/local/bin/lldb",
        "/usr/local/bin/lldb-18",
    ):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return os.path.realpath(candidate)
    fallback = shutil.which("lldb") or shutil.which("lldb-18")
    if fallback:
        resolved = os.path.realpath(fallback)
        if os.path.basename(resolved) in {"lldb", "lldb-18"}:
            return resolved
    raise RuntimeError("a7-lldb-driver-unavailable")


def _handoff_to_embedded_lldb() -> None:
    script = sys.argv[0] if sys.argv else ""
    if not _is_a7_provider_script(script):
        return

    lldb = _installed_lldb()
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
