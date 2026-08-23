from pathlib import Path
import re
p=Path('js/schema.js'); s=p.read_text()
def rep(old,new,label):
 global s
 c=s.count(old)
 if c!=1: raise SystemExit(f'{label}: expected 1, found {c}')
 s=s.replace(old,new,1)
rep("  if (opc === 2) return { d: rd(w), kind: 'movz', value: imm16 * 2 ** shift };\n","  if (opc === 2) return { d: rd(w), kind: 'movz', value: BigInt(imm16) << BigInt(shift) };\n",'movz')
rep("  const konst = new Int32Array(32).fill(0);\n","  const konst = new BigUint64Array(32);\n",'storage')
rep("      else if (known[mw.d]) konst[mw.d] |= mw.imm16 * 2 ** mw.shift;\n","      else if (known[mw.d]) {\n        const lane = 0xffffn << BigInt(mw.shift);\n        konst[mw.d] = (konst[mw.d] & ~lane) | (BigInt(mw.imm16) << BigInt(mw.shift));\n      }\n",'movk')
pat=r"(const k = known\[other\] \? konst\[other\] : null;\n\s*)if \(k\) last\.mul = k;"
s,c=re.subn(pat,r"\1const safeK = k != null && k <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(k) : null;\n          if (safeK) last.mul = safeK;",s,count=1)
if c!=1: raise SystemExit(f'multiplier: expected 1, found {c}')
p.write_text(s)
