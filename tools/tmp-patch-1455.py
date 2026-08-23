from pathlib import Path

p = Path('js/evidence.js')
s = p.read_text()

def rep(old, new, label):
    global s
    if s.count(old) != 1:
        raise SystemExit(f'{label}: expected 1 match, found {s.count(old)}')
    s = s.replace(old, new, 1)

marker = """export function evidenceKind(code) {
  const e = EVIDENCE[code];
  return e ? e.kind : 'inference';
}
"""
rep(marker, marker + """
function finiteStrength(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}
function finitePositiveLr(value, fallback = 1) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
""", 'helpers')
rep("  const s = strength == null ? 1 : Math.max(0, Math.min(1, strength));\n", "  const s = strength == null ? 1 : finiteStrength(strength, 0);\n  const fallbackLr = finitePositiveLr(info?.lr, 1);\n", 'strength')
rep("    lr: lr != null && lr > 0 ? lr : (info ? info.lr : 1),\n", "    lr: finitePositiveLr(lr, fallbackLr),\n", 'lr')
rep("  const all = (items || []).filter((x) => x && x.code);\n", "  const all = (items || []).filter((x) => x && x.code).map((x) => ({\n    ...x,\n    strength: finiteStrength(x.strength, x.strength == null ? 1 : 0),\n    lr: finitePositiveLr(x.lr, 1),\n  }));\n", 'fuse')
p.write_text(s)
