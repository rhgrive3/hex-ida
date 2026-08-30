from pathlib import Path

p = Path('js/targets/architecture/arm64/effects/addressing.js')
s = p.read_text()
old = """  if (typeof input.physicalId === 'string' && typeof input.kind === 'string') {\n    const parsed = arm64RegisterOperand(input.view || input.physicalId);\n    if (parsed) return { ...parsed, bits:Number(input.bits || parsed.bits), kind:input.kind, zero:!!input.zero };\n  }\n\n  if (typeof input.registerId === 'string') {\n    const parsed = arm64RegisterOperand(input.view || input.registerId);\n    if (parsed) return { ...parsed, bits: Number(input.widthBits || parsed.bits) };\n  }\n"""
new = """  if (typeof input.physicalId === 'string' && typeof input.kind === 'string') {\n    const parsed = arm64RegisterOperand(input.view || input.physicalId);\n    if (!parsed || parsed.physicalId !== input.physicalId || parsed.kind !== input.kind) return null;\n    if (input.bits != null && (typeof input.bits !== 'number' || !Number.isInteger(input.bits) || input.bits !== parsed.bits)) return null;\n    if (input.zero != null && (typeof input.zero !== 'boolean' || input.zero !== parsed.zero)) return null;\n    return parsed;\n  }\n\n  if (typeof input.registerId === 'string') {\n    const parsed = arm64RegisterOperand(input.view || input.registerId);\n    if (!parsed || parsed.physicalId !== input.registerId) return null;\n    if (input.widthBits != null && (typeof input.widthBits !== 'number' || !Number.isInteger(input.widthBits) || input.widthBits !== parsed.bits)) return null;\n    return parsed;\n  }\n"""
if old not in s:
    raise SystemExit('legacy register anchor missing')
p.write_text(s.replace(old, new, 1))

t = Path('tests/machine-effects/arm64-memory-register-identity.test.mjs')
s = t.read_text()
anchor = "assert.equal(arm64RegisterOperand({ k:'reg', cls:'zr', num:0, bits:64, text:'xzr' }), null);\n"
addition = anchor + """

// Legacy/internal structured forms must preserve their canonical physical identity.
assert.equal(arm64RegisterOperand({ kind:'gp', physicalId:'x2', view:'x2', bits:64, zero:false }).physicalId, 'x2');
assert.equal(arm64RegisterOperand({ kind:'gp', physicalId:'x2', view:'w2', bits:32, zero:false }).bits, 32);
assert.equal(arm64RegisterOperand({ registerId:'x2', view:'x2', widthBits:64 }).physicalId, 'x2');
assert.equal(arm64RegisterOperand({ kind:'gp', physicalId:'x2', view:'x2', bits:'64', zero:false }), null);
assert.equal(arm64RegisterOperand({ kind:'gp', physicalId:'x2', view:'x3', bits:64, zero:false }), null);
assert.equal(arm64RegisterOperand({ kind:'sp', physicalId:'x2', view:'x2', bits:64, zero:false }), null);
assert.equal(arm64RegisterOperand({ kind:'gp', physicalId:'x2', view:'x2', bits:64, zero:'false' }), null);
assert.equal(arm64RegisterOperand({ registerId:'x2', view:'x3', widthBits:64 }), null);
assert.equal(arm64RegisterOperand({ registerId:'x2', view:'x2', widthBits:'64' }), null);
"""
if anchor not in s:
    raise SystemExit('memory identity test anchor missing')
s = s.replace(anchor, addition, 1)
anchor2 = "assertLegal('cas', [gp(0), gp(1), mem(gp(2))]);\n"
addition2 = anchor2 + """
assertLegal('ldr', [gp(0), mem({ kind:'gp', physicalId:'x2', view:'x2', bits:64, zero:false })]);
assertFailClosed('ldr', [gp(0), mem({ kind:'sp', physicalId:'x2', view:'x2', bits:64, zero:false })]);
assertFailClosed('ldr', [gp(0), mem({ kind:'gp', physicalId:'x2', view:'x3', bits:64, zero:false })]);
assertFailClosed('ldr', [gp(0), mem({ kind:'gp', physicalId:'x2', view:'x2', bits:'64', zero:false })]);
"""
if anchor2 not in s:
    raise SystemExit('legal memory test anchor missing')
t.write_text(s.replace(anchor2, addition2, 1))
