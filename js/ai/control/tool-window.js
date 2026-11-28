const WINDOWS = Object.freeze({
  current: ['get_current_function','get_selection_context','get_semantic_facts','trace_value','get_cfg','get_callers','get_callees','lookup_signature','search_functions'],
  discovery: ['search_functions','search_strings','lookup_known_function','lookup_signature','get_function','get_semantic_facts','get_callers','get_callees','get_related_functions'],
  verification: ['verify_field_update','get_semantic_facts','trace_value','slice_backward','get_cfg','get_runtime_observations','verify_runtime_hypothesis','get_function'],
  project: ['project_search','get_binary_diff','compare_functions','lookup_known_function','lookup_signature','get_function'],
  runtime: ['get_runtime_observations','verify_runtime_hypothesis','get_current_function','get_semantic_facts','trace_value'],
});
const AUTO_ESCAPE_TOOLS = Object.freeze(['search_functions']);
const KNOWN_WINDOW_TOOLS = new Set(Object.values(WINDOWS).flat());

export function selectToolWindow(registry, options = {}) {
  const {
    requestedScope = 'auto',
    effectiveScope = 'function',
    intent = 'unknown',
    observations = [],
    hypotheses = [],
    maxTools = 10,
  } = options && typeof options === 'object' ? options : {};
  const obs = Array.isArray(observations) ? observations : [];
  const hyps = Array.isArray(hypotheses) ? hypotheses : [];
  const rawAvailable = registry?.definitionsForModel?.({ scope: effectiveScope });
  const available = [];
  const effectiveNames = new Set();
  if (Array.isArray(rawAvailable)) {
    for (const tool of rawAvailable) {
      if (!tool || typeof tool.name !== 'string' || effectiveNames.has(tool.name)) continue;
      available.push(tool);
      effectiveNames.add(tool.name);
    }
  }
  if (requestedScope === 'auto') {
    // Auto may expose a tiny, deliberate escape hatch from the wider registry
    // so the model can request evidence that triggers controlled expansion.
    // Everything else must already be valid in the current effective scope.
    const wider = registry?.definitionsForModel?.({ scope: 'auto' });
    if (Array.isArray(wider)) {
      for (const tool of wider) {
        if (tool && typeof tool.name === 'string' && AUTO_ESCAPE_TOOLS.includes(tool.name) && !effectiveNames.has(tool.name)) {
          available.push(tool);
          effectiveNames.add(tool.name);
        }
      }
    }
  }
  const phase = choosePhase({ intent, observations: obs, hypotheses: hyps, effectiveScope });
  const preferred = WINDOWS[phase] || WINDOWS.current;
  const byName = new Map(available.map((tool) => [tool.name, tool]));
  // The model-visible tool limit adopts only primitive finite non-negative
  // numbers; zero is meaningful when the Worker reserves the provider's sole
  // tool slot for submit_hex_result (#4591). Structured/boolean metadata still
  // falls back to 1 (#5423).
  const limit = typeof maxTools === 'number' && Number.isFinite(maxTools) && maxTools >= 0
    ? Math.max(0, Math.floor(maxTools))
    : 1;
  const selected = [];

  // Auto escape is a control-plane liveness guarantee, not an ordinary phase
  // preference. Reserve it before continuity and novel/filler slots so a
  // previous local tool or future-tool rotation can never push the only legal
  // path to wider evidence out of the window.
  if (requestedScope === 'auto') {
    for (const name of AUTO_ESCAPE_TOOLS) {
      if (byName.has(name) && !selected.some((item) => item.name === name) && selected.length < limit) selected.push(byName.get(name));
    }
  }

  // Preserve continuity after the liveness reservation. A phase transition
  // must not invalidate the immediately previous scope-valid tool, but it is
  // lower priority than the auto escape when the window has only one slot.
  const previousTool = previousToolName(obs);
  if (previousTool && byName.has(previousTool) && !selected.some((item) => item.name === previousTool) && selected.length < limit) {
    selected.push(byName.get(previousTool));
  }

  // ToolRegistry is allowed to grow independently of this control plane. Keep
  // a small rotating slot for scope-valid definitions not known when this file
  // was written. This is metadata-driven (already filtered by effectiveScope),
  // not a keyword guess, and guarantees new read tools do not become permanently
  // unreachable merely because their names are absent from the phase buckets.
  const novel = available.filter((tool) => !KNOWN_WINDOW_TOOLS.has(tool.name) && !AUTO_ESCAPE_TOOLS.includes(tool.name));
  const novelSlots = novel.length ? (limit >= 4 ? 2 : (obs.length % 2 ? 1 : 0)) : 0;
  const preferredLimit = Math.max(selected.length, limit - novelSlots);
  for (const name of preferred) {
    if (byName.has(name) && !selected.some((item) => item.name === name) && selected.length < preferredLimit) selected.push(byName.get(name));
  }
  addRotating(selected, novel, novelSlots, obs.length, limit);

  // Fill any remaining capacity from the scope-valid registry. This preserves
  // useful legacy behavior while avoiding a hard dependency on static names.
  for (const tool of available) {
    if (!selected.some((item) => item.name === tool.name) && selected.length < limit) selected.push(tool);
  }
  return { phase, tools: selected.slice(0, limit) };
}

export function choosePhase(options = {}) {
  const { intent, observations = [], hypotheses = [], effectiveScope } = options && typeof options === 'object' ? options : {};
  const obs = Array.isArray(observations) ? observations : [];
  const hyps = Array.isArray(hypotheses) ? hypotheses : [];
  if (effectiveScope === 'runtime' || intent === 'runtime-verify') return 'runtime';
  if (effectiveScope === 'project' || intent === 'project-query' || intent === 'compare') return 'project';
  const missingEvidence = hyps.some((item) => Array.isArray(item?.missingEvidence) && item.missingEvidence.length);
  const hasCandidate = obs.some((item) => ['search_functions','search_strings','deterministic_goal_planner'].includes(item?.tool));
  if (missingEvidence || (hasCandidate && obs.length > 1)) return 'verification';
  if (intent === 'find-behaviour' || intent === 'find-function' || effectiveScope === 'binary') return 'discovery';
  return 'current';
}

function addRotating(selected, tools, count, offset, limit) {
  if (!count || !tools.length) return;
  const safeOffset = typeof offset === 'number' && Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0;
  const start = safeOffset % tools.length;
  for (let index = 0; index < tools.length && count > 0 && selected.length < limit; index++) {
    const tool = tools[(start + index) % tools.length];
    if (selected.some((item) => item.name === tool.name)) continue;
    selected.push(tool);
    count--;
  }
}

function previousToolName(observations) {
  if (!Array.isArray(observations)) return null;
  for (let index = observations.length - 1; index >= 0; index--) {
    const name = observations[index]?.tool;
    if (name && name !== 'deterministic_goal_planner' && name !== 'protocol_guardrail') return name;
  }
  return null;
}
