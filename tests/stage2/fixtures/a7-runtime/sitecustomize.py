"""A7-only LLDB SWIG loader bridge for distro Python packaging.

LLDB may expose its wrapper directory via ``lldb -P`` while installing the
native ``_lldb`` extension in a child ``lldb`` directory (or a neighbouring
distro package path). Preload that exact installed native module before the
generated A7 provider script imports ``lldb``. This never emulates debugger
operations or observations; it only makes the installed provider importable.
"""
from __future__ import annotations

import glob
import os
import sys


def _candidate_extensions() -> list[str]:
    candidates: list[str] = []
    seen: set[str] = set()

    # Prefer the LLDB wrapper paths that the caller already put on sys.path.
    # This binds the native extension to the same installed provider selected
    # by ``lldb -P`` instead of blindly choosing the newest system package.
    for entry in sys.path:
        if not entry:
            continue
        for extension in sorted(glob.glob(os.path.join(entry, "lldb", "_lldb*.so"))):
            resolved = os.path.realpath(extension)
            if resolved not in seen:
                seen.add(resolved)
                candidates.append(resolved)

    # Debian/Ubuntu LLVM packages have used both site-packages and
    # dist-packages layouts across releases. Keep a bounded fallback for the
    # installed provider when its wrapper path does not directly expose the
    # extension directory.
    for pattern in (
        "/usr/lib/llvm-*/lib/python*/site-packages/lldb/_lldb*.so",
        "/usr/lib/llvm-*/lib/python*/dist-packages/lldb/_lldb*.so",
        "/usr/lib/python*/dist-packages/lldb/_lldb*.so",
    ):
        for extension in sorted(glob.glob(pattern)):
            resolved = os.path.realpath(extension)
            if resolved not in seen:
                seen.add(resolved)
                candidates.append(resolved)

    return candidates


def _load_lldb_extension() -> None:
    if "_lldb" in sys.modules:
        return
    for extension in _candidate_extensions():
        directory = os.path.dirname(extension)
        sys.path.insert(0, directory)
        try:
            __import__("_lldb")
            return
        except ImportError:
            sys.modules.pop("_lldb", None)
        finally:
            try:
                sys.path.remove(directory)
            except ValueError:
                pass


_load_lldb_extension()
