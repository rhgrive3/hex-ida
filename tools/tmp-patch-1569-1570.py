from pathlib import Path
p=Path('js/core/identity/index.js'); s=p.read_text()
def rep(old,new,label):
 global s
 c=s.count(old)
 if c!=1: raise SystemExit(f'{label}: expected 1, found {c}')
 s=s.replace(old,new,1)
rep("""function nonNegativeInteger(value, fallback, code) {
  if (value == null) return fallback;
  const number = Number(value);
""","""function nonNegativeInteger(value, fallback, code) {
  if (value == null) return fallback;
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) fail(code);
  const number = Number(value);
""",'slice integer')
rep("""export function createEvidenceId(input = {}) {
  return typedId('evidence', {
""","""export function createEvidenceId(input = {}) {
  const witness = lossyTypeWitness(input.identity);
  return typedId('evidence', {
""",'evidence witness declaration')
rep("""    identity: jsonSafe(input.identity),
  });
}

export function createAnnotationId""","""    identity: jsonSafe(input.identity),
    ...(witness ? { identityTypes: witness } : {}),
  });
}

export function createAnnotationId""",'evidence witness field')
p.write_text(s)
