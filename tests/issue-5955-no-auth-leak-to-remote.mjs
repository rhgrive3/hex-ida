// Regression for #5955: CapabilityExecutor's runtime.pause/runtime.continue
// handed the executor `options` object straight to the adapter, and
// RemoteDebugAdapter.pause/resume spread every non-`signal` field into the
// REMOTE METHOD PARAMS. The local control-plane authorization object
// (proposal token, proposal id) was therefore wire-sent to the remote debug
// peer. Only the abort signal crosses now.
import assert from 'node:assert/strict';
import { RemoteDebugAdapter } from '../js/adapters/index.js';
import { CapabilityExecutor } from '../js/ai/capabilities/executor.js';
import { createCapabilityCatalog } from '../js/ai/capabilities/catalog.js';
function recordingAdapter() {
  const sent = [];
  const transport = {
    async send(packet) { sent.push(packet); },
    onMessage() { return () => {}; },
  };
  const adapter = new RemoteDebugAdapter(transport, { capabilities: { pause: true, resume: true, connect: true, disconnect: true } });
  adapter.connected = true;
  adapter.protocol.send = async (packet) => { sent.push(packet); };
  adapter.protocol.transport.send = async (packet) => { sent.push(packet); };
  return { adapter, sent };
}

const authorization = { kind: 'proposal', token: 'approval_secret_token', proposalId: 'proposal_1' };

{
  // The decisive data flow: the built-in dispatch passes its `options` object
  // (holding the local control-plane authorization) straight to the adapter's
  // pause/resume.
  const { adapter, sent } = recordingAdapter();
  const platform = { currentSession: () => ({ id: 'sess-1', adapter }) };
  const executor = new CapabilityExecutor({ catalog: createCapabilityCatalog(), runtimePlatform: platform });
  const entry = executor.catalog.get('runtime.pause');
  const pauseCall = executor.executeBuiltIn(entry, { runtimeSessionId: 'sess-1' }, { authorization }, platform);
  pauseCall.catch(() => {}); // no transport peer: the request times out, the wire packet is what matters
  await new Promise((resolve) => setTimeout(resolve, 20));
  const pausePacket = sent.find((packet) => packet.method === 'pause');
  assert.ok(pausePacket, 'the approved pause request is sent');
  assert.equal(JSON.stringify(pausePacket.params ?? {}).includes('approval_secret_token'), false,
    'the control-plane authorization token must never be wire-sent to the remote peer');
  assert.equal(JSON.stringify(pausePacket.params ?? {}).includes('proposal_1'), false);
}

{
  // Same for runtime.continue.
  const { adapter, sent } = recordingAdapter();
  const platform = { currentSession: () => ({ id: 'sess-1', adapter }) };
  const executor = new CapabilityExecutor({ catalog: createCapabilityCatalog(), runtimePlatform: platform });
  const entry = executor.catalog.get('runtime.continue');
  const resumeCall = executor.executeBuiltIn(entry, { runtimeSessionId: 'sess-1' }, { authorization }, platform);
  resumeCall.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  const resumePacket = sent.find((packet) => packet.method === 'resume');
  assert.ok(resumePacket, 'the approved resume request is sent');
  assert.equal(JSON.stringify(resumePacket.params ?? {}).includes('approval_secret_token'), false,
    'the control-plane authorization token must never be wire-sent to the remote peer');
}


// Direct adapter callers receive the same data-plane isolation as the executor.
{
  const { adapter, sent } = recordingAdapter();
  const pauseCall = adapter.pause({ authorization, proposalId: 'proposal_1' });
  pauseCall.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  const pausePacket = sent.find((packet) => packet.method === 'pause');
  assert.ok(pausePacket, 'the direct pause request is sent');
  assert.deepEqual(pausePacket.params, {}, 'pause has no remote params and must drop local control metadata');
}

{
  const { adapter, sent } = recordingAdapter();
  const resumeCall = adapter.resume({ authorization, proposalId: 'proposal_1' });
  resumeCall.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  const resumePacket = sent.find((packet) => packet.method === 'resume');
  assert.ok(resumePacket, 'the direct resume request is sent');
  assert.deepEqual(resumePacket.params, {}, 'resume has no remote params and must drop local control metadata');
}
