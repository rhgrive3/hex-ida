// Regression for #5098: UserscriptAIProvider delegates getCapabilities(request)
// to the selected child (fixed in #5701), but the turn execution path never
// passes the request into the capability/budget boundary. executeTurn() calls
// providerCapabilities(this.provider) -> getCapabilities() argless, so the
// budget authority follows the GLOBAL selection while nextTurn() follows
// request.provider. When those differ the capability authority and the actual
// executing provider diverge, so a turn routed to one child is still budgeted
// against the other child's capabilities.
//
// The authority must follow the same selection input as nextTurn(): the child
// that actually runs the turn is also the child whose capabilities drive the
// tool window / semantic / wire budget for that turn.
import assert from 'node:assert/strict';
import { AIRuntime } from '../js/ai/runtime.js';
import { UserscriptAIProvider } from '../js/ai/provider/chatgpt-web.js';

const FINAL = { type: 'final', answer: 'done', confidence: 0.9, evidenceIds: [], followups: [] };
const context = { binaryId: 'fixture:1', searchFunctions: async () => [], searchStrings: async () => [], addressExists: () => true };

// Distinct, sub-ceiling maxTools so the 1..10 clamp (#5423) cannot mask the
// mismatch: the tool-window size is a direct readout of the capability authority.
const GEMINI_MAX_TOOLS = 9;
const CHATGPT_MAX_TOOLS = 2;

function routerWithPreparedChildren() {
  const provider = new UserscriptAIProvider({ bridge: { request: async () => '{"type":"final","answer":"ok"}' }, fetchImpl: async () => { throw new Error('network unused'); } });
  provider.gemini.capabilitiesPrepared = true;
  provider.gemini.providerCapabilities = { ...provider.gemini.getCapabilities(), provider: 'gemini', maxTools: GEMINI_MAX_TOOLS };
  provider.chatgpt.providerCapabilities = { ...provider.chatgpt.getCapabilities(), provider: 'chatgpt-web', maxTools: CHATGPT_MAX_TOOLS };
  const route = { child: null, toolCount: null };
  const spy = (name) => (request) => { route.child = name; route.toolCount = (request.tools || []).length; return FINAL; };
  provider.gemini.nextTurn = spy('gemini');
  provider.chatgpt.nextTurn = spy('chatgpt');
  return { provider, route };
}

async function runTurn({ requestProvider, globalProvider }) {
  const previous = globalThis.__HEX_AI_PROVIDER__;
  globalThis.__HEX_AI_PROVIDER__ = globalProvider;
  const { provider, route } = routerWithPreparedChildren();
  try {
    const runtime = new AIRuntime({ context, provider, planner: false });
    await runtime.turn({ mode: 'agent', goal: 'capability authority must follow the turn route', provider: requestProvider });
  } finally {
    if (previous === undefined) delete globalThis.__HEX_AI_PROVIDER__;
    else globalThis.__HEX_AI_PROVIDER__ = previous;
  }
  return route;
}

{
  // #5098 core case: the request selects Gemini while the persisted global
  // selection is ChatGPT. nextTurn() must run Gemini AND the budget authority
  // must be Gemini, not the globally selected ChatGPT child.
  const route = await runTurn({ requestProvider: 'gemini', globalProvider: 'chatgpt-web' });
  assert.equal(route.child, 'gemini', 'the turn must be routed to the request-selected Gemini child');
  assert.equal(route.toolCount, GEMINI_MAX_TOOLS,
    `a Gemini turn must budget against the Gemini capability authority (${GEMINI_MAX_TOOLS} tools), ` +
    `not the globally selected provider (${route.toolCount} observed)`);
}

{
  // Symmetry: the request selects ChatGPT while the global selection is Gemini.
  const route = await runTurn({ requestProvider: 'chatgpt-web', globalProvider: 'gemini' });
  assert.equal(route.child, 'chatgpt', 'the turn must be routed to the request-selected ChatGPT child');
  assert.equal(route.toolCount, CHATGPT_MAX_TOOLS,
    `a ChatGPT turn must budget against the ChatGPT capability authority (${CHATGPT_MAX_TOOLS} tools), ` +
    `not the globally selected provider (${route.toolCount} observed)`);
}

{
  // #6 preserved: a request with no per-turn provider still follows the global
  // selection, so the standalone/default behavior is unchanged.
  const route = await runTurn({ requestProvider: undefined, globalProvider: 'gemini' });
  assert.equal(route.child, 'gemini', 'an unspecified request provider falls back to the global selection');
  assert.equal(route.toolCount, GEMINI_MAX_TOOLS, 'the global-selected child remains the budget authority when no request provider is given');
}

console.log('issue #5098 turn capability authority regressions PASS');
