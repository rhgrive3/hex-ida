#!/usr/bin/env python3
"""Deterministic identifier taxonomy for the direct-recompilability study.

The patterns below are derived from the observed population of undefined
identifiers in the frozen corpus, but are written as general producer
contracts, not as a per-case allowlist.

Category A -> translation-unit packaging / declaration completeness
Category B -> decompiler function-body emission defect
Category C -> ambiguous / unclassified
"""

import re

# --- Category A patterns -------------------------------------------------

RE_GLOBAL_DATA = re.compile(r"^global_[0-9A-Fa-f]+$")
RE_EXTERN_FUNC = re.compile(r"^sub_[0-9A-Fa-f]+$")
RE_BARE_INT_ALIAS = re.compile(r"^u?int(8|16|32|64|128)$")
RE_STD_INT_ALIAS = re.compile(
    r"^(u?int(8|16|32|64|128)_t|intptr_t|uintptr_t|intmax_t|uintmax_t|"
    r"size_t|ssize_t|ptrdiff_t|bool|float32_t|float64_t)$"
)
RE_VECTOR_ALIAS = re.compile(r"^vector(64|128|256|512)$")

# Type-ish names that the corpus emits in cast position for a language type
# the TU never declares (C++ class names seen in the C++-source cases).
KNOWN_TYPE_NAMES = {
    "Base",
    "Derived",
    "Container",
    "MultiDerived",
    "DiamondDerived",
    "std",
    "string",
    "vector",
}

RUNTIME_HELPERS = {"unknown_call"}

# --- Category B patterns -------------------------------------------------

RE_GPR64 = re.compile(r"^x[0-9]{1,2}(_[0-9]+)?$")
RE_GPR32 = re.compile(r"^w[0-9]{1,2}(_[0-9]+)?$")
RE_SIMD = re.compile(r"^[dsq][0-9]{1,2}(_[0-9]+)?$")
RE_ARG = re.compile(r"^a[0-9]{1,2}(_[0-9]+)?$")
RE_VEC_RET = re.compile(r"^v[0-9]{1,2}(_[0-9]+)?$")
RE_ARCH_REG = re.compile(r"^(xzr|wzr|lr|pc|sp|fp)$")
RE_STACK_SLOT = re.compile(r"^(local_|var_|field_).+$")
RE_CALL_TMP = re.compile(r"^call_[0-9]+$")
RE_PHI_TMP = re.compile(r"^local_phi_.*$")
RE_COND_TMP = re.compile(r"^condition_[a-z]+$")
EMITTER_PLACEHOLDERS = {"memory_unknown", "memory", "result"}


def classify_identifier(name):
    """Return (category, kind) for an undefined identifier."""
    if not name:
        return "C", "empty"

    if name in RUNTIME_HELPERS:
        return "A", "missing-runtime-declaration"
    if RE_GLOBAL_DATA.match(name):
        return "A", "missing-global-declaration"
    if RE_EXTERN_FUNC.match(name):
        return "A", "missing-external-function-declaration"
    if RE_BARE_INT_ALIAS.match(name):
        return "A", "missing-typedef/nonstandard-integer-alias"
    if RE_STD_INT_ALIAS.match(name):
        return "A", "missing-standard-type-alias"
    if RE_VECTOR_ALIAS.match(name):
        return "A", "missing-typedef/vector-alias"
    if name in KNOWN_TYPE_NAMES:
        return "A", "missing-type-declaration"
    if name == "main":
        return "A", "missing-entry-point"

    if RE_GPR64.match(name):
        return "B", "undeclared-gpr64-pseudo-variable"
    if RE_GPR32.match(name):
        return "B", "undeclared-gpr32-pseudo-variable"
    if RE_SIMD.match(name):
        return "B", "undeclared-simd-pseudo-variable"
    if RE_ARG.match(name):
        return "B", "undeclared-argument-pseudo-variable"
    if RE_VEC_RET.match(name):
        return "B", "undeclared-vector/return-pseudo-variable"
    if RE_ARCH_REG.match(name):
        return "B", "undeclared-architecture-register"
    if RE_STACK_SLOT.match(name):
        return "B", "undeclared-stack-slot-variable"
    if RE_CALL_TMP.match(name):
        return "B", "undeclared-generated-call-temporary"
    if RE_PHI_TMP.match(name):
        return "B", "undeclared-ssa-phi-temporary"
    if RE_COND_TMP.match(name):
        return "B", "undeclared-condition-temporary"
    if name in EMITTER_PLACEHOLDERS:
        return "B", "undeclared-emitter-placeholder"

    return "C", "unclassified"


if __name__ == "__main__":
    import sys

    for n in sys.argv[1:]:
        print(n, classify_identifier(n))
