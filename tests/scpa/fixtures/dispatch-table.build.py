"""Reuse the owned LLVM assembler/minimal-ELF builder for the dispatch fixture."""
from pathlib import Path
import json
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory() as temp:
    stage = Path(temp)
    shutil.copyfile(root / "threaded-call-memory.build.py", stage / "threaded-call-memory.build.py")
    shutil.copyfile(root / "dispatch-table.s", stage / "threaded-call-memory.s")
    subprocess.run(["python", str(stage / "threaded-call-memory.build.py")], check=True, timeout=30, capture_output=True)
    manifest = json.loads((stage / "threaded-call-memory.json").read_text())
    manifest.update(source="dispatch-table.s", binary="dispatch-table.elf",
                    rebuild=["timeout", "40s", "python", "dispatch-table.build.py"])
    (root / "dispatch-table.elf").write_bytes((stage / "threaded-call-memory.elf").read_bytes())
    (root / "dispatch-table.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"assembler": manifest["assembler"], "binarySha256": manifest["binarySha256"]}))
