from pathlib import Path

# Compatibility shim for the one-shot repair runner. The runner was drafted
# against a slightly older presentation-table spelling; current main uses cat().
arm = Path('js/arm64.js')
text = arm.read_text()
old = "cat('nop hint bti svc hvc smc brk hlt dmb dsb isb yield wfe wfi sev sevl mrs msr sys eret clrex paciasp pacibsp pacia pacib pacda pacdb paciza pacizb pacdza pacdzb pacia1716 pacib1716 autiasp autibsp autia autib autda autdb autiza autizb autdza autdzb autia1716 autib1716 xpaci xpacd xpaclri pacga dc ic tlbi', 'system');"
new = "cat('nop hint bti svc hvc smc brk hlt dmb dsb isb yield wfe wfi sev sevl mrs msr sys eret eretaa eretab clrex paciasp pacibsp pacia pacib pacda pacdb paciza pacizb pacdza pacdzb pacia1716 pacib1716 autiasp autibsp autia autib autda autdb autiza autizb autdza autdzb autia1716 autib1716 xpaci xpacd xpaclri pacga dc ic tlbi', 'system');"
if old not in text:
    raise SystemExit('#2705 current cat() inventory not found')
arm.write_text(text.replace(old, new, 1))

runner = Path('tools/unlinked-repair-20260830.py')
r = runner.read_text()
start = r.index('# #2705 —')
end = r.index('# #2732 —', start)
r = r[:start] + '# #2705 — applied by unlinked-repair-compat-20260830.py for current cat() inventory.\n\n' + r[end:]
runner.write_text(r)
print('repair runner compatibility applied')
