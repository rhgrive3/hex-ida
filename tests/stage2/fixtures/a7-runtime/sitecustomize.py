"""CI-local LLDB SWIG loader bridge for Ubuntu/Debian packaging.

The versioned LLDB Python package can be on sys.path before the directory
containing its native _lldb extension. Load that exact extension as the
expected top-level module before the generated A7 provider script imports
`lldb`. This does not emulate any debugger operation; it only makes the
installed provider binding importable.
"""
from __future__ import annotations

import glob
import importlib.util
import os
import sys


def _load_lldb_extension() -> None:
    if "_lldb" in sys.modules:
        return
    candidates = sorted(glob.glob("/usr/lib/llvm-*/lib/python3/dist-packages/lldb/_lldb.so"))
    if not candidates:
        return
    extension = os.path.realpath(candidates[-1])
    spec = importlib.util.spec_from_file_location("_lldb", extension)
    if spec is None or spec.loader is None:
        return
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sys.modules["_lldb"] = module


_load_lldb_extension()
