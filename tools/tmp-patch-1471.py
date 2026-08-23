from pathlib import Path
p=Path('js/program.js'); s=p.read_text()
def rep(old,new,label):
 global s
 c=s.count(old)
 if c!=1: raise SystemExit(f'{label}: expected 1, found {c}')
 s=s.replace(old,new,1)
marker='function entryFromBounds('
if s.count(marker)!=1: raise SystemExit('queryLimit marker mismatch')
helper="""function queryLimit(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

"""
s=s.replace(marker,helper+marker,1)
for sig,d in [('callSitesTo(target, limit = 500)',500),('callersOf(target, limit = 200)',200),('calleesOf(start, end, limit = 200)',200),('refSitesTo(addr, span = 1n, limit = 500)',500),('functionsReferencing(addr, span = 1n, limit = 200)',200),('refsFrom(start, end, limit = 400)',400),('mostCalled(limit = 20)',20)]:
 old=f'  {sig} {{\n'; rep(old,old+f'    limit = queryLimit(limit, {d});\n',sig)
p.write_text(s)
