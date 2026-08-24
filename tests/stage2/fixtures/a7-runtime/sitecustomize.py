"""CI-local LLDB SWIG loader bridge for Ubuntu/Debian packaging.

The versioned LLDB Python package can be on sys.path before the directory
containing its native _lldb extension. Preload that exact installed native
module before the generated A7 provider script imports `lldb`. This does not
emulate any debugger operation; it only makes the installed provider binding
importable.
"""
from __future__ import annotations

import glob
import os
import sys


def _load_lldb_extension() -> None:
    if "_lldb" in sys.modules:
        return
    candidates = sorted(glob.glob("/usr/lib/llvm-*/lib/python3/dist-packages/lldb/_lldb.so"))
    for extension in reversed(candidates):
        directory = os.path.dirname(os.path.realpath(extension))
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
