import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';

import { createPruningProxy } from '../jev-context/proxy/server.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function rawRequest(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => socket.end(request));
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('error', reject);
    socket.on('end', () => resolve(data));
  });
}

function normalRequest(port, path, authorization) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { authorization, 'content-type':'application/json' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end('{}');
  });
}

const pipeline = { config: { usable:false } };

test('#9364 absolute-form request targets cannot override configured upstream origin', async () => {
  let expectedCalls = 0;
  let captureCalls = 0;
  let captureAuth = null;
  const expected = http.createServer((req, res) => { expectedCalls += 1; res.end('ok'); });
  const capture = http.createServer((req, res) => { captureCalls += 1; captureAuth = req.headers.authorization; res.end('captured'); });
  const expectedPort = await listen(expected);
  const capturePort = await listen(capture);
  const proxy = createPruningProxy({ upstream:`http://127.0.0.1:${expectedPort}`, pipeline });
  const proxyServer = await proxy.listen({ host:'127.0.0.1', port:0 });
  const proxyPort = proxyServer.address().port;
  try {
    const response = await rawRequest(proxyPort, [
      `POST http://127.0.0.1:${capturePort}/steal HTTP/1.1`,
      `Host: 127.0.0.1:${proxyPort}`,
      'Authorization: Bearer test-provider-secret',
      'Content-Type: application/json',
      'Content-Length: 2',
      'Connection: close',
      '',
      '{}',
    ].join('\r\n'));
    assert.match(response, /^HTTP\/1\.1 400 /);
    assert.equal(captureCalls, 0);
    assert.equal(captureAuth, null);
    assert.equal(expectedCalls, 0);

    const status = await normalRequest(proxyPort, '/v1/responses?x=1', 'Bearer test-provider-secret');
    assert.equal(status, 200);
    assert.equal(expectedCalls, 1);
  } finally {
    await Promise.all([close(proxyServer), close(expected), close(capture)]);
  }
});

test('#9364 unsupported request-target forms fail closed before upstream I/O', async () => {
  let expectedCalls = 0;
  const expected = http.createServer((req, res) => { expectedCalls += 1; res.end('ok'); });
  const expectedPort = await listen(expected);
  const proxyServer = await createPruningProxy({ upstream:`http://127.0.0.1:${expectedPort}`, pipeline }).listen({ host:'127.0.0.1', port:0 });
  const proxyPort = proxyServer.address().port;
  try {
    const response = await rawRequest(proxyPort, [
      'OPTIONS * HTTP/1.1',
      `Host: 127.0.0.1:${proxyPort}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n'));
    assert.match(response, /^HTTP\/1\.1 400 /);
    assert.equal(expectedCalls, 0);
  } finally {
    await Promise.all([close(proxyServer), close(expected)]);
  }
});
