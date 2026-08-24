"""A7-only launcher bridge for LLDB's embedded Python runtime.

The Ubuntu/Debian LLDB package can expose a Python wrapper that external
``python3`` cannot import because the native ``_lldb`` binding is packaged
separately. The A7 proof runners invoke only generated, bounded provider
scripts from temporary ``hex-a7-*`` directories. For exactly those scripts,
replace the external Python process with the installed LLDB driver and execute
the same script in LLDB's embedded interpreter, where ``_lldb`` is registered
by LLDB itself.

For QEMU linux-user cross-target active proofs, LLDB 18 otherwise chooses its
conservative 512-byte gdb-remote memory transfer size when QEMU does not
advertise a packet limit. The tracked probe is exactly eight bytes and may sit
at the end of a mapped data page, so a 512-byte ``m`` request can cross the
mapping and fail even though the requested eight-byte value is readable. The
cross-target bridge therefore applies LLDB's own ``process plugin packet
xfer-size 8`` setting immediately after a successful gdb-remote connection.
This only changes packet chunking: all register, memory, state, stop-ID, PID,
and execution-progress values still come from the real provider session.

This file never fabricates debugger results and never runs for arbitrary
repository Python. It only selects the installed provider's supported Python
entry path and, for the bounded QEMU scripts, configures the provider's own
memory-transfer size before the proof script continues.
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


def _cross_remote_prelude() -> str:
    # LLDB's gdb-remote process plugin defaults to a conservative 512-byte
    # transfer if the remote stub does not advertise a maximum. QEMU
    # linux-user's tiny tracked probe must be read as the requested 8 bytes,
    # not as a cache-fill that crosses an unmapped boundary. Use LLDB's own
    # process-plugin control immediately after ConnectRemote succeeds.
    return r'''
import lldb
_a7_original_connect_remote = lldb.SBTarget.ConnectRemote

def _a7_connect_remote_with_bounded_memory(self, *args):
    process = _a7_original_connect_remote(self, *args)
    if process.IsValid():
        result = lldb.SBCommandReturnObject()
        self.GetDebugger().GetCommandInterpreter().HandleCommand(
            "process plugin packet xfer-size 8", result
        )
        if not result.Succeeded():
            raise RuntimeError(
                "a7-cross-gdb-remote-xfer-size-failed:"
                + (result.GetError() or result.GetOutput() or "unknown")
            )
    return process

lldb.SBTarget.ConnectRemote = _a7_connect_remote_with_bounded_memory
'''


def _handoff_to_embedded_lldb() -> None:
    script = sys.argv[0] if sys.argv else ""
    if not _is_a7_provider_script(script):
        return

    lldb = _installed_lldb()
    script = os.path.realpath(script)
    base = os.path.basename(script)
    env = os.environ.copy()
    # The embedded interpreter obtains its Python paths from LLDB itself.
    # Do not carry the external-wrapper PYTHONPATH into the embedded runtime.
    env.pop("PYTHONPATH", None)
    script_literal = repr(script)
    prelude = _cross_remote_prelude() if base.startswith("a7-cross-active-") else ""
    python_command = (
        ("exec(" + repr(prelude) + ");")
        + "exec(compile(open("
        + script_literal
        + ", 'rb').read(), "
        + script_literal
        + ", 'exec'), {'__name__': '__main__', '__file__': "
        + script_literal
        + "})"
    )
    argv = [
        lldb,
        "-b",
        "-Q",
        "-o",
        "settings set symbols.enable-external-lookup false",
        "-o",
        f"script {python_command}",
        "-o",
        "quit",
    ]
    os.execve(lldb, argv, env)


_handoff_to_embedded_lldb()