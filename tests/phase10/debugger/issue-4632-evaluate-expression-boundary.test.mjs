import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter, RemoteDebugAdapter } from '../../../js/adapters/index.js';

function expectCode(error, code) {
  assert.equal(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`);
  return true;
}

// Local evaluate must accept only primitive strings. Structured values must not
// be coerced into a canonical register selector or touch sandbox state.
{
  let reads = 0;
  const local = new LocalFunctionSandboxAdapter({});
  local.sandbox = {
    getRegister(name) {
      reads += 1;
      assert.equal(name, 'x0');
      return 0x1234n;
    },
  };

  assert.equal(await local.evaluate(' x0 '), 0x1234n);
  assert.equal(reads, 1);

  let coercions = 0;
  const hostile = { toString() { coercions += 1; return 'x0'; } };
  let proxyGets = 0;
  const proxy = new Proxy({}, { get() { proxyGets += 1; return 'x0'; } });
  for (const value of [['x0'], hostile, proxy, new String('x0'), 0, true, null, undefined, Symbol('x0')]) {
    await assert.rejects(local.evaluate(value), (error) => expectCode(error, 'invalid-argument'));
  }
  assert.equal(coercions, 0, 'local evaluate must not invoke structured input coercion hooks');
  assert.equal(proxyGets, 0, 'local evaluate must reject proxies without property access');
  assert.equal(reads, 1, 'rejected local expressions must not read register state');

  await assert.rejects(local.evaluate('x31'), (error) => expectCode(error, 'unsupported-expression'));
  assert.equal(reads, 1);
}

// Remote evaluate must reject non-string expressions before any wire request,
// while preserving the existing 4096-character bound and normal string path.
{
  let receive = () => {};
  const sent = [];
  const transport = {
    send(packet) {
      sent.push(packet);
      if (packet.type !== 'request') return;
      if (packet.method === 'connect') {
        queueMicrotask(() => receive({
          version: packet.version,
          type: 'response',
          id: packet.id,
          epoch: packet.epoch,
          result: { capabilities: { evaluate: true } },
        }));
      } else if (packet.method === 'evaluate') {
        queueMicrotask(() => receive({
          version: packet.version,
          type: 'response',
          id: packet.id,
          epoch: packet.epoch,
          result: { echoed: packet.params.expression },
        }));
      }
    },
    onMessage(handler) { receive = handler; return () => { receive = () => {}; }; },
  };

  const remote = new RemoteDebugAdapter(transport, {
    capabilities: { evaluate: true },
    protocol: { timeoutMs: 1000 },
  });
  await remote.connect();

  const exact = 'x'.repeat(4096);
  assert.deepEqual(await remote.evaluate(exact, 'watch'), { echoed: exact });
  await assert.rejects(remote.evaluate('x'.repeat(4097), 'watch'), (error) => expectCode(error, 'too-large'));

  const requestsBeforeInvalid = sent.filter((packet) => packet.type === 'request').length;
  let coercions = 0;
  const hostile = { toString() { coercions += 1; return 'x0 + 4'; } };
  let proxyGets = 0;
  const proxy = new Proxy({}, { get() { proxyGets += 1; return 'x0 + 4'; } });
  for (const value of [['x0 + 4'], hostile, proxy, new String('x0 + 4'), 1, false, null, undefined, Symbol('x0')]) {
    await assert.rejects(remote.evaluate(value, 'watch'), (error) => expectCode(error, 'invalid-argument'));
  }
  assert.equal(coercions, 0, 'remote evaluate must not invoke structured input coercion hooks');
  assert.equal(proxyGets, 0, 'remote evaluate must reject proxies without property access');
  assert.equal(
    sent.filter((packet) => packet.type === 'request').length,
    requestsBeforeInvalid,
    'rejected remote expressions must not reach the transport',
  );
  remote.protocol.close();
}

console.log('issue 4632 evaluate expression boundary: ok');
