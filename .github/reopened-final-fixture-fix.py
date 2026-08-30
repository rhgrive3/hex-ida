from pathlib import Path
p=Path('tests/reopened-final-seven-contracts.mjs')
s=p.read_text()
old="  resolveStrings(Object.assign([], {complete:true})); resolveShapes(Object.assign(new Map(),{complete:true}));\n"
new="  resolveStrings(Object.assign([], {complete:true})); const shapeValue=Object.assign(new Map(),{complete:true}); app.shapes=shapeValue; resolveShapes(shapeValue);\n"
if s.count(old)!=1: raise SystemExit('DAG shape fixture target missing')
p.write_text(s.replace(old,new,1))
