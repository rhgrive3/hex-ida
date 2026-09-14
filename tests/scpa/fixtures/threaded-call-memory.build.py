"""Rebuild an owned assembly fixture using the installed LLVM C API.

No frontend/compiler-twin or system linker evidence is claimed. LLVM assembles
the source; this script wraps its relocation-free text and function symbols in
a minimal ELF executable used solely as parser/decoder/analysis test input.
Run with a finite process timeout; no external download is performed.
"""
import ctypes as c
import ctypes.util
import hashlib
import json
from pathlib import Path
import struct
import tempfile


def main():
    root = Path(__file__).resolve().parent
    source = root / "threaded-call-memory.s"
    library = ctypes.util.find_library("LLVM-20") or ctypes.util.find_library("LLVM")
    if not library:
        raise RuntimeError("LLVM shared library with AArch64 support is required")
    llvm = c.CDLL(library)

    def api(name, result, *args):
        fn = getattr(llvm, name)
        fn.restype, fn.argtypes = result, args
        return fn

    for component in ["TargetInfo", "Target", "TargetMC", "AsmParser", "AsmPrinter"]:
        api("LLVMInitializeAArch64" + component, None)()
    version = [c.c_uint() for _ in range(3)]
    api("LLVMGetVersion", None, *([c.POINTER(c.c_uint)] * 3))(*(c.byref(x) for x in version))
    context = api("LLVMContextCreate", c.c_void_p)()
    module = api("LLVMModuleCreateWithNameInContext", c.c_void_p, c.c_char_p, c.c_void_p)(b"threaded-call-memory", context)
    machine = None
    try:
        triple = b"aarch64-unknown-linux-gnu"
        api("LLVMSetTarget", None, c.c_void_p, c.c_char_p)(module, triple)
        data = source.read_bytes()
        api("LLVMSetModuleInlineAsm2", None, c.c_void_p, c.c_char_p, c.c_size_t)(module, data, len(data))
        target, error = c.c_void_p(), c.c_char_p()
        status = api("LLVMGetTargetFromTriple", c.c_int, c.c_char_p, c.POINTER(c.c_void_p), c.POINTER(c.c_char_p))(triple, c.byref(target), c.byref(error))
        if status:
            raise RuntimeError(error.value)
        machine = api("LLVMCreateTargetMachine", c.c_void_p, c.c_void_p, c.c_char_p, c.c_char_p, c.c_char_p, c.c_int, c.c_int, c.c_int)(target, triple, b"generic", b"", 0, 0, 0)
        if not machine:
            raise RuntimeError("LLVM target machine unavailable")
        with tempfile.TemporaryDirectory() as tmp:
            obj = Path(tmp) / "fixture.o"
            status = api("LLVMTargetMachineEmitToFile", c.c_int, c.c_void_p, c.c_void_p, c.c_char_p, c.c_int, c.POINTER(c.c_char_p))(machine, module, str(obj).encode(), 1, c.byref(error))
            if status:
                raise RuntimeError(error.value)
            assembled = obj.read_bytes()
    finally:
        if machine:
            api("LLVMDisposeTargetMachine", None, c.c_void_p)(machine)
        api("LLVMDisposeModule", None, c.c_void_p)(module)
        api("LLVMContextDispose", None, c.c_void_p)(context)

    # Read the actual assembler output. Reject every relocation: this wrapper
    # deliberately cannot resolve external calls or stand in for a linker.
    assert assembled[:6] == b"\x7fELF\x02\x01"
    shoff = struct.unpack_from("<Q", assembled, 40)[0]
    shsize, shnum, shstrndx = struct.unpack_from("<HHH", assembled, 58)
    sections = [struct.unpack_from("<IIQQQQIIQQ", assembled, shoff + i * shsize) for i in range(shnum)]

    def payload(section):
        return assembled[section[4]:section[4] + section[5]]

    names = payload(sections[shstrndx])
    text_index = next(i for i, sec in enumerate(sections) if names[sec[0]:].split(b"\0", 1)[0] == b".text")
    assert not any(sec[1] in (4, 9) and sec[5] for sec in sections), "relocations unsupported"
    text = payload(sections[text_index])
    symbols_section = next(sec for sec in sections if sec[1] == 2)
    symbol_names = payload(sections[symbols_section[6]])
    symbols = []
    for offset in range(symbols_section[4], symbols_section[4] + symbols_section[5], symbols_section[9]):
        name, info, _, section, value, size = struct.unpack_from("<IBBHQQ", assembled, offset)
        if info & 15 == 2 and section == text_index:
            symbols.append((symbol_names[name:].split(b"\0", 1)[0], value, size))
    assert [row[0] for row in symbols] == [b"entry", b"callee", b"copy_word"]

    base, text_offset = 0x1000, 0x1000
    image = bytearray(text_offset) + text
    strings, table = bytearray(b"\0"), bytearray(24)
    for name, offset, size in symbols:
        table.extend(struct.pack("<IBBHQQ", len(strings), 0x12, 0, 1, base + offset, size))
        strings.extend(name + b"\0")
    shstrings = b"\0.text\0.symtab\0.strtab\0.shstrtab\0"

    def append(data, align=1):
        image.extend(b"\0" * (-len(image) % align))
        offset = len(image)
        image.extend(data)
        return offset

    sym_offset = append(table, 8)
    str_offset = append(strings)
    names_offset = append(shstrings)
    section_offset = append(b"", 8)
    elf_sections = [(0,) * 10,
                    (1, 1, 6, base, text_offset, len(text), 0, 0, 4, 0),
                    (7, 2, 0, 0, sym_offset, len(table), 3, 1, 8, 24),
                    (15, 3, 0, 0, str_offset, len(strings), 0, 0, 1, 0),
                    (23, 3, 0, 0, names_offset, len(shstrings), 0, 0, 1, 0)]
    for row in elf_sections:
        image.extend(struct.pack("<IIQQQQIIQQ", *row))
    ident = b"\x7fELF\x02\x01\x01" + b"\0" * 9
    struct.pack_into("<16sHHIQQQIHHHHHH", image, 0, ident, 2, 183, 1, base, 64, section_offset, 0, 64, 56, 1, 64, len(elf_sections), 4)
    struct.pack_into("<IIQQQQQQ", image, 64, 1, 5, text_offset, base, base, len(text), len(text), 0x1000)
    binary = root / "threaded-call-memory.elf"
    binary.write_bytes(image)
    manifest = {
        "schema": "scpa-owned-assembled-fixture/v1",
        "source": source.name,
        "binary": binary.name,
        "sourceSha256": hashlib.sha256(data).hexdigest(),
        "binarySha256": hashlib.sha256(image).hexdigest(),
        "assembler": "LLVM " + ".".join(str(x.value) for x in version) + " AArch64 C API",
        "assemblerObjectSha256": hashlib.sha256(assembled).hexdigest(),
        "container": "Minimal ELF wrapper; relocation-free assembler output and original function extents",
        "rebuild": ["timeout", "30s", "python", "threaded-call-memory.build.py"],
        "expectedFunctions": [{"name": name.decode(), "start": hex(base + offset), "end": hex(base + offset + size)} for name, offset, size in symbols],
        "claim": "Test-owned assembled ELF fixture; not compiler-twin, native execution, competitor, browser, or physical-device evidence."
    }
    (root / "threaded-call-memory.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"assembler": manifest["assembler"], "bytes": len(image), "functions": manifest["expectedFunctions"]}))


if __name__ == "__main__":
    main()
