from pathlib import Path
p=Path('js/core/scheduler/analysis-scheduler.js'); s=p.read_text()
def rep(old,new,label):
 global s
 c=s.count(old)
 if c!=1: raise SystemExit(f'{label}: expected 1, found {c}')
 s=s.replace(old,new,1)
old="""function priorityValue(value) {
  if (typeof value === 'string' && Object.hasOwn(ANALYSIS_PRIORITY, value)) return ANALYSIS_PRIORITY[value];
  if (typeof value === 'string' && value.trim() === '') throw new TypeError('analysis-priority-invalid');
  const n = Number(value ?? ANALYSIS_PRIORITY.current);
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('analysis-priority-invalid');
  return n;
}
"""
new="""function strictSafeInteger(value, fallback, code, min = 0) {
  const raw = value == null ? fallback : value;
  if (typeof raw !== 'number' && !(typeof raw === 'string' && raw.trim() !== '')) throw new TypeError(code);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min) throw new TypeError(code);
  return n;
}
function priorityValue(value) {
  if (typeof value === 'string' && Object.hasOwn(ANALYSIS_PRIORITY, value)) return ANALYSIS_PRIORITY[value];
  return strictSafeInteger(value, ANALYSIS_PRIORITY.current, 'analysis-priority-invalid');
}
"""
rep(old,new,'priority')
rep("  const expected = [...(request.descriptor?.upstreamArtifactIds || [])].map(String).sort();\n","  const upstream = request.descriptor?.upstreamArtifactIds;\n  if (upstream != null && !Array.isArray(upstream)) throw new SchedulerDependencyIdentityError(artifactId, [String(upstream)], actual);\n  const expected = (upstream || []).map(String).sort();\n",'upstream')
rep("    if (!Number.isSafeInteger(Number(starvationInterval)) || Number(starvationInterval) <= 0) throw new TypeError('scheduler-starvation-interval-invalid');\n    this.store=store; this.maxConcurrency=maxConcurrency; this.starvationInterval=Number(starvationInterval); this.defaultBudget=defaultBudget;\n","    const normalizedStarvationInterval = strictSafeInteger(starvationInterval, 8, 'scheduler-starvation-interval-invalid', 1);\n    this.store=store; this.maxConcurrency=maxConcurrency; this.starvationInterval=normalizedStarvationInterval; this.defaultBudget=defaultBudget;\n",'starvation')
p.write_text(s)
