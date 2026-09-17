export const SUBJECT_RESULT_SCHEMA = 'hex-public-benchmark-subject/v1';

export const SUBJECT_RESULT_STATES = new Set([
  'PASS',
  'UNSUPPORTED',
  'CRASH',
  'TIMEOUT',
  'ERROR',
]);

export function countFunctionStates(functions) {
  const counts = new Map();
  for (const fn of Array.isArray(functions) ? functions : []) {
    const state = typeof fn?.state === 'string' && fn.state ? fn.state : 'UNKNOWN';
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

export function classifySubjectResult(result) {
  const functionStateCounts = countFunctionStates(result.functions);
  let state = result.state;
  if (state === 'PASS') {
    if (functionStateCounts.CRASH) state = 'CRASH';
    else if (functionStateCounts.TIMEOUT) state = 'TIMEOUT';
  }
  return {
    ...result,
    state,
    ...(state === result.state ? {} : { reason: `function-${state.toLowerCase()}` }),
    functionStateCounts,
  };
}

export function parseSubjectOutput(stdout) {
  const line = String(stdout ?? '').split(/\r?\n/).map(value => value.trim()).filter(Boolean).at(-1);
  if (!line) return { error: 'subject-output-empty' };

  let result;
  try {
    result = JSON.parse(line);
  } catch {
    return { error: 'subject-output-invalid-json' };
  }

  if (!result || typeof result !== 'object' || Array.isArray(result)
    || result.schema !== SUBJECT_RESULT_SCHEMA
    || !SUBJECT_RESULT_STATES.has(result.state)
    || !Array.isArray(result.functions)) {
    return { error: 'subject-result-invalid' };
  }
  return { result: classifySubjectResult(result), reportedState: result.state };
}
