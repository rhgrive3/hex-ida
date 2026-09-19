// LLM-assisted recompilability lane, shaped after CodeFuse-DeBench Step 2
// (`evaluator/syntactic/auto_fixer_v3.py`): compile -> parse errors -> ask the
// model for a patch via tool calls -> apply -> retry, bounded by maxAttempts.
//
// The repair lane is separate from the raw lane by construction: this module
// never mutates or returns the raw source, it returns a distinct `repairedSource`
// and the caller records both variants under different artifact names.

import { LlmMalformedResponseError, LlmTimeoutError, LlmHttpError } from './llm-client.mjs';

export const MAX_REPAIR_ATTEMPTS_LIMIT = 50;

// Tool schemas transcribed from upstream `TOOLS` in auto_fixer_v3.py.
export const REPAIR_TOOLS = Object.freeze([
  Object.freeze({
    type: 'function',
    function: Object.freeze({
      name: 'edit_code_block',
      description: 'Replace a specific block of code with new code. This is the SAFER and PREFERRED way to edit code.',
      parameters: Object.freeze({
        type: 'object',
        properties: Object.freeze({
          search_block: Object.freeze({ type: 'string', description: 'The exact lines of code you want to replace.' }),
          replace_block: Object.freeze({ type: 'string', description: 'The new code that will replace the search_block.' }),
        }),
        required: Object.freeze(['search_block', 'replace_block']),
      }),
    }),
  }),
  Object.freeze({
    type: 'function',
    function: Object.freeze({
      name: 'replace_string',
      description: 'Replace occurrences of a string. Use ONLY for global typo/type replacements.',
      parameters: Object.freeze({
        type: 'object',
        properties: Object.freeze({
          old_str: Object.freeze({ type: 'string', description: 'The exact string to find' }),
          new_str: Object.freeze({ type: 'string', description: 'The string to replace it with' }),
          replace_all: Object.freeze({ type: 'boolean', description: 'If true, replace ALL occurrences. Default: false' }),
        }),
        required: Object.freeze(['old_str', 'new_str']),
      }),
    }),
  }),
]);

const SYSTEM_PROMPT = 'You are an expert C programmer fixing compilation errors in decompiled code. '
  + 'You use the edit_code_block tool to change code. '
  + 'IMPORTANT RULES:\n'
  + '1. Fix the ROOT CAUSE. If something is undeclared, define it globally or include a header.\n'
  + '2. You MUST write the exact search_block as it appears currently in the file.\n'
  + '3. You CAN and SHOULD output multiple tool calls at once for errors in different places.\n'
  + '4. If an approach failed, switch your approach. Do not retry the same edit.';

// Strict, deterministic patch application. A patch that cannot be applied
// unambiguously is a hard failure (`tool_call_invalid`), matching upstream's
// "write the exact search_block" contract.
export function applyPatch(source, { name, arguments: args }) {
  if (name === 'edit_code_block') {
    const search = args?.search_block;
    const replace = args?.replace_block;
    if (typeof search !== 'string' || typeof replace !== 'string') {
      return { ok: false, reason: 'edit_code_block-arguments-invalid' };
    }
    if (search.length === 0) return { ok: false, reason: 'edit_code_block-empty-search' };
    const first = source.indexOf(search);
    if (first < 0) return { ok: false, reason: 'edit_code_block-search-not-found' };
    if (source.indexOf(search, first + 1) >= 0) return { ok: false, reason: 'edit_code_block-search-not-unique' };
    return { ok: true, source: source.slice(0, first) + replace + source.slice(first + search.length) };
  }
  if (name === 'replace_string') {
    const oldStr = args?.old_str;
    const newStr = args?.new_str;
    if (typeof oldStr !== 'string' || typeof newStr !== 'string') {
      return { ok: false, reason: 'replace_string-arguments-invalid' };
    }
    if (oldStr.length === 0) return { ok: false, reason: 'replace_string-empty-search' };
    const first = source.indexOf(oldStr);
    if (first < 0) return { ok: false, reason: 'replace_string-search-not-found' };
    if (args?.replace_all === true) return { ok: true, source: source.split(oldStr).join(newStr) };
    return { ok: true, source: source.slice(0, first) + newStr + source.slice(first + oldStr.length) };
  }
  return { ok: false, reason: `unsupported-tool:${name}` };
}

function summarizeErrors(diagnostics) {
  if (!diagnostics) return 'No diagnostics parsed.';
  const first = diagnostics.firstError;
  const firstText = first ? `line ${first.line ?? '?'}: ${first.message}` : 'no first error line';
  return `total_errors=${diagnostics.errorCount ?? 0} warnings=${diagnostics.warningCount ?? 0}\nfirst error: ${firstText}`;
}

function buildUserMessage({ phase, diagnostics, iteration, maxAttempts }) {
  return [
    `CURRENT PHASE: ${phase.toUpperCase()}`,
    `ITERATION: ${iteration}/${maxAttempts}`,
    '',
    '## Current Errors to Fix',
    summarizeErrors(diagnostics),
    '',
    '## Instructions',
    'Use the `edit_code_block` tool to fix the errors. You may make MULTIPLE tool calls in one response.',
    'To remove code, set `replace_block` to an empty string.',
  ].join('\n');
}

// `check` is an injected async (source) => { status, phase, diagnostics } so the
// loop is fully testable without a compiler. `client` is a createLlmClient()
// instance (or any object exposing `chat`).
export async function repairSource({
  source,
  client,
  check,
  maxAttempts = 8,
  onIteration = null,
} = {}) {
  if (typeof source !== 'string' || !source.trim()) throw new TypeError('codefuse-repair-requires-source');
  if (typeof check !== 'function') throw new TypeError('codefuse-repair-requires-check');
  if (typeof client?.chat !== 'function') throw new TypeError('codefuse-repair-requires-client');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_REPAIR_ATTEMPTS_LIMIT) {
    throw new TypeError(`codefuse-repair-attempts-out-of-range:${maxAttempts}`);
  }

  let current = source;
  const history = [];
  for (let iteration = 1; iteration <= maxAttempts; iteration += 1) {
    const result = await check(current);
    if (result?.status === 'success') {
      return { status: 'success', attempts: iteration - 1, repairedSource: current, history: Object.freeze(history), failureReason: null };
    }
    if (result?.status === 'timeout' || result?.status === 'spawn_error') {
      return { status: result.status, attempts: iteration - 1, repairedSource: current, history: Object.freeze(history), failureReason: result.reason ?? result.status };
    }

    let response;
    try {
      response = await client.chat({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserMessage({ phase: result?.phase ?? 'compile', diagnostics: result?.diagnostics, iteration, maxAttempts }) },
        ],
        tools: REPAIR_TOOLS,
      });
    } catch (error) {
      const status = error instanceof LlmMalformedResponseError ? 'malformed_response'
        : error instanceof LlmTimeoutError ? 'api_timeout'
          : error instanceof LlmHttpError ? 'api_error' : 'api_error';
      history.push({ iteration, phase: result?.phase ?? 'compile', error: status, message: String(error?.message || error) });
      return { status, attempts: iteration - 1, repairedSource: current, history: Object.freeze(history), failureReason: String(error?.message || error) };
    }

    if (!response.toolCalls || response.toolCalls.length === 0) {
      history.push({ iteration, phase: result?.phase ?? 'compile', error: 'tool_call_missing', contentChars: response.content?.length ?? 0 });
      return { status: 'tool_call_invalid', attempts: iteration, repairedSource: current, history: Object.freeze(history), failureReason: 'no-tool-call-in-response' };
    }

    let applied = 0;
    const appliedNames = [];
    for (const toolCall of response.toolCalls) {
      const patch = applyPatch(current, toolCall);
      if (!patch.ok) {
        history.push({ iteration, phase: result?.phase ?? 'compile', error: 'tool_call_invalid', reason: patch.reason, tool: toolCall.name });
        return { status: 'tool_call_invalid', attempts: iteration, repairedSource: current, history: Object.freeze(history), failureReason: patch.reason };
      }
      current = patch.source;
      applied += 1;
      appliedNames.push(toolCall.name);
    }
    const entry = {
      iteration,
      phase: result?.phase ?? 'compile',
      errorCount: result?.diagnostics?.errorCount ?? null,
      firstError: result?.diagnostics?.firstErrorRaw ?? null,
      toolCalls: appliedNames,
      patchesApplied: applied,
      contentChars: response.content?.length ?? 0,
      usage: response.usage ?? null,
    };
    history.push(entry);
    onIteration?.(entry);
  }

  return { status: 'compile_failed', attempts: maxAttempts, repairedSource: current, history: Object.freeze(history), failureReason: 'max-attempts-reached' };
}
