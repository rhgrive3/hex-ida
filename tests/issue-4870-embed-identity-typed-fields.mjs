import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { MessageChannel } from 'node:worker_threads';

import {
  EMBED_PATH,
  waitForEmbedParentAttach,
} from '../js/userscript/embed-child.js';
import {
  buildSandboxSrcdoc,
} from '../js/userscript/chatgpt-sandbox-host.js';
import {
  createEmbedBootstrapMessage,
  normalizeEmbedGeneration,
  normalizeSandboxToken,
  waitForEmbedChildBootstrap,
} from '../js/userscript/embed-bootstrap.js';
import {
  EMBED_PROTOCOL,
  EMBED_PROTOCOL_VERSION,
  createEmbedNonce,
} from '../js/userscript/embed-protocol.js';

const TOKEN = 'ab'.repeat(32);
const worker = 'https://ida.rhgrive.workers.dev';

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function eventTarget() {
  const listeners = new Set();
  return {
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
    dispatch(event) { for (const fn of [...listeners]) fn(event); },
  };
}

// The canonicalizer must not promote a structured value into a protocol identity.
{
  assert.equal(normalizeEmbedGeneration('7'), '7');
  assert.equal(normalizeEmbedGeneration(7), '7');
  assert.equal(normalizeSandboxToken(TOKEN.toUpperCase()), TOKEN);
  for (const [label, value] of [
    ['single-element array', [7]],
    ['array with toString', [TOKEN]],
    ['object with toString', { toString:() => '7' }],
    ['boolean', true],
    ['null prototype object', Object.assign(Object.create(null), { valueOf:() => 7 })],
  ]) {
    assert.throws(() => normalizeEmbedGeneration(value), /Invalid Hex embed generation/i, `generation as ${label}`);
    assert.throws(() => normalizeSandboxToken(value), /Invalid Hex sandbox token/i, `sandbox token as ${label}`);
  }
  assert.throws(() => normalizeSandboxToken([7]), /Invalid Hex sandbox token/i);
}

// The parent bootstrap-ready receiver must not treat structured identity fields as the identity.
{
  const parent = eventTarget();
  const child = {};
  let settled = false;
  const pending = waitForEmbedChildBootstrap({
    windowRef:parent,
    expectedSource:child,
    opaque:true,
    sandboxToken:TOKEN,
    generation:'1',
    timeoutMs:60,
  }).then((value) => { settled = true; return value; });

  parent.dispatch({ source:child, origin:'null', data:{ ...createEmbedBootstrapMessage('1', TOKEN), generation:[1] } });
  parent.dispatch({ source:child, origin:'null', data:{ ...createEmbedBootstrapMessage('1', TOKEN), sandboxToken:[TOKEN] } });
  parent.dispatch({ source:child, origin:'null', data:{ ...createEmbedBootstrapMessage('1', TOKEN), generation:{ toString:() => '1' } } });
  parent.dispatch({ source:child, origin:'null', data:{ ...createEmbedBootstrapMessage('1', TOKEN), sandboxToken:{ toLowerCase:() => TOKEN } } });
  parent.dispatch({ source:child, origin:'null', data:{ ...createEmbedBootstrapMessage('2', TOKEN), generation:[2] } });
  await delay(10);
  assert.equal(settled, false, 'structured generation/sandboxToken must never satisfy the handshake');

  parent.dispatch({ source:child, origin:'null', data:createEmbedBootstrapMessage('1', TOKEN) });
  const result = await pending;
  assert.equal(result.generation, '1');
  assert.equal(result.sandboxToken, TOKEN);
  await assert.rejects(waitForEmbedChildBootstrap({
    windowRef:parent, expectedSource:child, opaque:true, sandboxToken:TOKEN, generation:'3', timeoutMs:10,
  }), (error) => error?.code === 'EMBED_BOOTSTRAP_TIMEOUT');
}

// The opaque sandbox bootstrap must bind the runtime transfer to typed identity.
{
  const trustedRuntimeSource = 'globalThis.__HEX_TEST_RUNTIME__=true;';
  const runtimeContentHash = createHash('sha256').update(trustedRuntimeSource).digest('hex');
  const html = buildSandboxSrcdoc({
    hostHtml:'<main id="app"></main>',
    cspNonce:'sandbox-nonce-1',
    generation:7,
    sandboxToken:TOKEN,
    apiOrigin:worker,
    virtualSrc:`${worker}/embed/chatgpt?__hex_embed_generation=7`,
    loaderVersion:'2.0.test',
    buildId:'0123456789abcdef01234567',
    runtimeContentHash,
  });
  const bootstrap = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script><\/body>/)?.[1];
  assert.ok(bootstrap, 'sandbox bootstrap source must be extractable');
  const listeners = new Map();
  const appended = [];
  const parent = { postMessage() {} };
  const context = {
    parent,
    URL,
    ArrayBuffer,
    Uint8Array,
    TextDecoder,
    crypto:webcrypto,
    globalThis:null,
    document:{
      createElement() { return { type:'', nonce:'', textContent:'', addEventListener() {}, remove() {} }; },
      head:{ append(node) { appended.push(node); } },
    },
    addEventListener(type, handler) { listeners.set(type, handler); },
  };
  context.globalThis = context;
  vm.runInNewContext(bootstrap, context);
  const onMessage = listeners.get('message');
  const envelope = (identity) => ({
    source:parent,
    origin:'https://chatgpt.com',
    data:{
      type:'hex.embed.runtime', protocol:EMBED_PROTOCOL, version:EMBED_PROTOCOL_VERSION,
      ...identity, runtime:new TextEncoder().encode(trustedRuntimeSource).buffer,
    },
  });

  await onMessage(envelope({ generation:[7], sandboxToken:TOKEN }));
  await onMessage(envelope({ generation:'7', sandboxToken:[TOKEN] }));
  await onMessage(envelope({ generation:{ toString:() => '7' }, sandboxToken:{ toLowerCase:() => TOKEN } }));
  await onMessage(envelope({ generation:'8', sandboxToken:TOKEN }));
  await onMessage(envelope({ generation:'7', sandboxToken:'cd'.repeat(32) }));
  assert.equal(appended.length, 0, 'structured or mismatched identity must not receive the protected runtime');

  await onMessage(envelope({ generation:'7', sandboxToken:TOKEN }));
  assert.equal(appended.length, 1, 'the primitive typed identity handshake must still deliver the runtime');
  assert.equal(appended[0].textContent, trustedRuntimeSource);
}

// The child attach receiver must apply the same typed contract.
{
  for (const identity of [{ generation:['12'] }, { sandboxToken:[TOKEN] }]) {
    const parent = { postMessage() {} };
    const window = fakeChildWindow(parent);
    const channel = new MessageChannel();
    const nonce = createEmbedNonce();
    const pending = waitForEmbedParentAttach({
      window,
      location:locationForGeneration(12),
      expectedParent:parent,
      globalObject:{ __HEX_EMBED_SANDBOX_TOKEN__:TOKEN },
      timeoutMs:20,
    });
    window.dispatchMessage({
      origin:'https://chatgpt.com',
      source:parent,
      ports:[channel.port1],
      data:{ type:'hex.embed.attach', protocol:EMBED_PROTOCOL, version:EMBED_PROTOCOL_VERSION, nonce, generation:'12', sandboxToken:TOKEN, ...identity },
    });
    await assert.rejects(pending, /attach timeout/, `structured ${Object.keys(identity)[0]} must be ignored`);
    channel.port1.close(); channel.port2.close();
  }

  const parent = { postMessage() {} };
  const window = fakeChildWindow(parent);
  const channel = new MessageChannel();
  const nonce = createEmbedNonce();
  const pending = waitForEmbedParentAttach({
    window,
    location:locationForGeneration(12),
    expectedParent:parent,
    globalObject:{ __HEX_EMBED_SANDBOX_TOKEN__:TOKEN },
    timeoutMs:100,
  });
  window.dispatchMessage({
    origin:'https://chatgpt.com',
    source:parent,
    ports:[channel.port1],
    data:{ type:'hex.embed.attach', protocol:EMBED_PROTOCOL, version:EMBED_PROTOCOL_VERSION, nonce, generation:'12', sandboxToken:TOKEN },
  });
  const result = await pending;
  assert.equal(result.nonce, nonce);
  assert.equal(result.generation, '12');
  assert.equal(result.sandboxToken, TOKEN);
  channel.port1.close(); channel.port2.close();
}

function fakeChildWindow(parent) {
  const listeners = new Set();
  return {
    parent,
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
    dispatchMessage(event) { for (const fn of [...listeners]) fn(event); },
  };
}
function locationForGeneration(generation) {
  const search = `?__hex_embed_generation=${generation}`;
  return {
    origin:worker, hostname:'ida.rhgrive.workers.dev', pathname:EMBED_PATH, search,
    href:`${worker}${EMBED_PATH}${search}`,
  };
}

console.log('issue #4870 embed identity typed contract regressions PASS');
