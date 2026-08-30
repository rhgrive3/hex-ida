from pathlib import Path
p=Path('.github/reopened-final-repair.py')
s=p.read_text()
old="""for kind in ['callers','callees']:
    old=f"const {{ program, reason }} = await localProgram(id, '{kind}', options);"
    new=f"const {{ program, reason, scannedRegionIds, unscannedRegionIds }} = await localProgram(id, '{kind}', options);"
    if text.count(old)!=1: raise SystemExit(f'{kind} destructure mismatch')
    text=text.replace(old,new,1)
"""
new="""old="const { program, reason } = await localProgram(id, 'callers', options);"
new="const { program, reason, scannedRegionIds, unscannedRegionIds } = await localProgram(id, 'callers', options);"
if text.count(old)!=1: raise SystemExit('callers destructure mismatch')
text=text.replace(old,new,1)
old="const { program, reason } = await localProgram(address, 'callees', options);"
new="const { program, reason, scannedRegionIds, unscannedRegionIds } = await localProgram(address, 'callees', options);"
if text.count(old)!=1: raise SystemExit('callees destructure mismatch')
text=text.replace(old,new,1)
"""
if s.count(old)!=1:
    raise SystemExit('patcher loop target missing')
p.write_text(s.replace(old,new,1))
