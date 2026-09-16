from pathlib import Path

p = Path('js/rebuild/transaction-v2.js')
s = p.read_text()
assert 'function loaderReparseResultFailure' not in s
anchor = 'function independentOracleResultFailure(result, context) {'
assert s.count(anchor) == 1
helper = """function loaderReparseResultFailure(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'validator-loader-result-invalid';
  const image = result.image;
  for (const [fields, imageField, reason] of [
    [['format'], 'format', 'validator-format-identity-required'],
    [['architecture', 'arch'], 'arch', 'validator-architecture-identity-required'],
    [['loaderVersion', 'parserVersion'], 'loaderVersion', 'validator-loader-identity-required'],
    [['outputHash', 'bytesHash'], 'outputHash', 'validator-output-identity-required'],
  ]) {
    const values = validatorIdentityValues(result, image, fields, imageField);
    if (values.length === 0 || values.some((value) => typeof value === 'string' && value.trim() === '')) return reason;
  }
  return null;
}

"""
s = s.replace(anchor, helper + anchor, 1)
hook = "    const identityFailure = formatIdentityMismatch(result, context.transaction, context.expectedOutputHash);"
assert s.count(hook) == 1
s = s.replace(hook, "    if (name === 'loader-reparse') {\n      const contractFailure = loaderReparseResultFailure(result);\n      if (contractFailure) return validatorResult(name, true, false, contractFailure, result);\n    }\n" + hook, 1)
p.write_text(s)

p = Path('tests/issue-5785-validator-contradiction.test.mjs')
s = p.read_text()
anchor = "  assert.equal(materialized.status, 'materialized');\n"
assert s.count(anchor) == 1
insert = """  const loaderIdentity = {
    format: transaction.format,
    architecture: transaction.architecture,
    loaderVersion: transaction.loaderVersion,
    sourceHash: transaction.sourceHash,
    outputHash: materialized.outputHash,
  };
"""
s = s.replace(anchor, anchor + insert, 1)
old = '    loaderReparse: validatorFn,'
new = '    loaderReparse: async (context) => ({ ...loaderIdentity, ...await validatorFn(context) }),' 
assert s.count(old) == 1
p.write_text(s.replace(old, new, 1))

p = Path('tests/stage2/helpers/rebuild-proof-fixture.mjs')
s = p.read_text()
old = '    loaderReparse: () => ({ ok: true }),' 
new = "    loaderReparse: () => ({ ok: true, status: 'passed', format: transaction.format, architecture: transaction.architecture, loaderVersion: transaction.loaderVersion, sourceHash: transaction.sourceHash, outputHash: materialized.outputHash }),"
assert s.count(old) == 1
p.write_text(s.replace(old, new, 1))

p = Path('tests/stage2/rebuild-transaction.test.mjs')
s = p.read_text()
old = '  loaderReparse: ({ output }) => ({ ok: output.length === 5 }),' 
new = '  loaderReparse: ({ output }) => ({ ok: output.length === 5, format: transaction.format, architecture: transaction.architecture, loaderVersion: transaction.loaderVersion, sourceHash: transaction.sourceHash, outputHash: materialized.outputHash }),' 
assert s.count(old) == 1
s = s.replace(old, new, 1)
start = s.index('const countedValidation')
end = s.index('const tamperedOutput', start)
segment = s[start:end]
old = '  loaderReparse: () => ({ ok: true }),' 
new = '  loaderReparse: () => ({ ok: true, format: transaction.format, architecture: transaction.architecture, loaderVersion: transaction.loaderVersion, sourceHash: transaction.sourceHash, outputHash: materialized.outputHash }),' 
assert segment.count(old) == 1
s = s[:start] + segment.replace(old, new, 1) + s[end:]
old = "  original: source, loaderReparse: () => ({ ok: true }), independentOracle: ({ output }) => independentEvidence(output, true, { format: 'elf' }), validators: boundExternal,"
new = "  original: source, loaderReparse: () => ({ ok: true, format: boundTransaction.format, architecture: boundTransaction.architecture, loaderVersion: boundTransaction.loaderVersion, sourceHash: boundTransaction.sourceHash, outputHash: boundMaterialized.outputHash }), independentOracle: ({ output }) => independentEvidence(output, true, { format: 'elf' }), validators: boundExternal,"
assert s.count(old) == 1
p.write_text(s.replace(old, new, 1))
