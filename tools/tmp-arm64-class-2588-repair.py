from pathlib import Path


def replace(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'anchor missing: {path}: {old!r}')
    p.write_text(s.replace(old, new, 1))

replace(
    'js/targets/architecture/arm64/effects/integer.js',
    "function regClass(op) { return op?.k === 'reg' ? String(op.cls || '').toLowerCase() : ''; }",
    "function regClass(op) { return op?.k === 'reg' && typeof op.cls === 'string' ? op.cls.toLowerCase() : ''; }",
)
replace(
    'js/targets/architecture/arm64/effects/index.js',
    "function isGpOrZrRegister(operand) {\n  return operand?.k === 'reg' && ['gp','zr'].includes(String(operand.cls || '').toLowerCase());\n}",
    "function isGpOrZrRegister(operand) {\n  return operand?.k === 'reg' && typeof operand.cls === 'string' && ['gp','zr'].includes(operand.cls.toLowerCase());\n}",
)

p = Path('tests/machine-effects/arm64-structured-width-validation.test.mjs')
s = p.read_text()
anchor = "assertFailClosed(lift('add', [gp(0), gp(1), { ...gp(2), bits:64.5 }]), 'ADD fractional width');\n"
addition = anchor + "assertFailClosed(lift('add', [{ ...gp(0), cls:{ toString(){ return 'gp'; } } }, gp(1), gp(2)]), 'ADD object register class');\nassertFailClosed(lift('add', [gp(0), { ...gp(1), cls:['gp'] }, gp(2)]), 'ADD array register class');\n"
if anchor not in s:
    raise SystemExit('test anchor missing')
p.write_text(s.replace(anchor, addition, 1))
