from pathlib import Path


def resolve_conflicts(path, mode):
    p = Path(path)
    lines = p.read_text().splitlines(keepends=True)
    out = []
    state = None
    ours = []
    theirs = []
    for line in lines:
        if line.startswith('<<<<<<< '):
            if state is not None:
                raise SystemExit(f'nested conflict in {path}')
            state = 'ours'; ours = []; theirs = []
        elif state == 'ours' and line.startswith('======='):
            state = 'theirs'
        elif state == 'theirs' and line.startswith('>>>>>>> '):
            if mode == 'ours': out.extend(ours)
            elif mode == 'theirs': out.extend(theirs)
            elif mode == 'both': out.extend(ours); out.extend(theirs)
            else: raise SystemExit(f'bad mode {mode}')
            state = None
        elif state == 'ours': ours.append(line)
        elif state == 'theirs': theirs.append(line)
        else: out.append(line)
    if state is not None:
        raise SystemExit(f'unclosed conflict in {path}')
    p.write_text(''.join(out))

# These conflicts are old v1 discovery wiring versus the newer T016 v2 contract.
for path in [
    'js/analysis/discovery/producers.js',
    'js/analysis/index.js',
    'js/rebuild/transaction-v2.js',
]:
    resolve_conflicts(path, 'theirs')

# Keep both exact branch routing cases; the surrounding non-conflicting current-main
# additions remain untouched.
resolve_conflicts('.circleci/config.yml', 'both')

# Preserve the #7036 negative section-table-bound regression, then exercise the
# newer current-main low-alignment valid layout as the positive case.
resolve_conflicts('tests/issue-4135-pe-section-virtual-layout.mjs', 'ours')
p = Path('tests/issue-4135-pe-section-virtual-layout.mjs')
s = p.read_text()
old = """  const layout = {\n    bits: 32, machine: 0x014c, sectionAlignment: 0x10, fileAlignment: 0x10, sizeOfHeaders: 0x200,\n    sections: [\n      { name: '.a', rva: 0x200, vsize: 0x30, rawSize: 0x30, ptr: 0x200 },\n      { name: '.b', rva: 0x240, vsize: 0x30, rawSize: 0x30, ptr: 0x240 },\n    ],\n  };\n  assert.throws(() => parsePE(buildPE({ ...layout, sizeOfHeaders:0x100 })), /SizeOfHeaders.*section table/,\n    'low alignment does not waive the complete section-table header bound');\n  const image = parsePE(buildPE(layout));\n  assert.equal(image.metadata.peMetadata.complete, true, 'low-alignment aligned/ascending layout stays complete');\n  assert.equal(canonical(image, 0x200).length + canonical(image, 0x240).length, 2);\n"""
new = """  const boundedLayout = {\n    bits: 32, machine: 0x014c, sectionAlignment: 0x10, fileAlignment: 0x10, sizeOfHeaders: 0x200,\n    sections: [\n      { name: '.a', rva: 0x200, vsize: 0x30, rawSize: 0x30, ptr: 0x200 },\n      { name: '.b', rva: 0x240, vsize: 0x30, rawSize: 0x30, ptr: 0x240 },\n    ],\n  };\n  assert.throws(() => parsePE(buildPE({ ...boundedLayout, sizeOfHeaders: 0x100 })), /SizeOfHeaders.*section table/,\n    'low alignment does not waive the complete section-table header bound');\n  const image = parsePE(buildPE({\n    bits: 32, machine: 0x014c, sectionAlignment: 0x10, fileAlignment: 0x10, sizeOfHeaders: 0x1d0,\n    sections: [\n      { name: '.a', rva: 0x100, vsize: 0x30, rawSize: 0x30, ptr: 0x100 },\n      { name: '.b', rva: 0x140, vsize: 0x30, rawSize: 0x30, ptr: 0x140 },\n    ],\n  }));\n  assert.equal(image.metadata.peMetadata.complete, true, 'low-alignment aligned/ascending layout stays complete');\n  assert.equal(canonical(image, 0x100).length + canonical(image, 0x140).length, 2);\n"""
if old not in s:
    raise SystemExit('PE selected block not found')
p.write_text(s.replace(old, new, 1))
