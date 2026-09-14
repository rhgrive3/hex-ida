import { compileGoal } from '../../goalc.js';

function ownString(value, key, max) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') return null;
  const text = descriptor.value.trim();
  return text ? text.slice(0, max) : null;
}

export function normalizePlannerTargetHint(value) {
  const kind = ownString(value, 'kind', 64);
  let term = null;
  let source = null;
  if (kind === 'field') {
    term = ownString(value, 'label', 1024);
    source = 'label';
  } else if (kind === 'binary-string') {
    term = ownString(value, 'text', 2048) || ownString(value, 'address', 128);
    source = ownString(value, 'text', 2048) ? 'text' : 'address';
  } else if (kind === 'function') {
    term = ownString(value, 'name', 1024) || ownString(value, 'address', 128);
    source = ownString(value, 'name', 1024) ? 'name' : 'address';
  } else if (kind === 'instruction') {
    term = ownString(value, 'text', 2048) || ownString(value, 'address', 128);
    source = ownString(value, 'text', 2048) ? 'text' : 'address';
  }
  return term ? Object.freeze({ kind, source, term }) : null;
}

export function plannerGoalWithTargetHint(goal, value) {
  const targetHint = normalizePlannerTargetHint(value);
  if (!targetHint) return goal;
  const query = typeof goal === 'string' ? compileGoal(goal) : goal;
  if (!query || typeof query !== 'object' || Array.isArray(query)) return goal;
  const entity = query.entity && typeof query.entity === 'object' && !Array.isArray(query.entity) ? query.entity : {};
  const terms = Array.isArray(entity.terms) ? entity.terms : [];
  return {
    ...query,
    entity: { ...entity, terms: [targetHint.term, ...terms] },
    targetHint,
  };
}
