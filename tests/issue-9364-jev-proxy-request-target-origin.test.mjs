import assert from "node:assert/strict";
import http from "node:http";

import { createPruningProxy } from "../jev-context/proxy/server.mjs";

function inertPipeline() {
  return {
    config: { usable: false, mode: "off", background: false },
    saveState() {},
    async run() { throw new Error("disabled pipeline should not run"); },
    async prewarm() {},
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

async function request({ port, path, authorization }) {
  return await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      method: "POST",
      path,
      headers: {
        authorization,
        "content-type": "application/json",
        "content-length": "2",
      },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end("{}");
  });
}

let expectedCalls = 0;
let captureCalls = 0;
let expectedAuthorization = null;
const expected = await listen(http.createServer((req, res) => {
  expectedCalls += 1;
  expectedAuthorization = req.headers.authorization || null;
  res.writeHead(200).end("{}");
}));
const capture = await listen(http.createServer((req, res) => {
  captureCalls += 1;
  res.writeHead(200).end("{}");
}));

const proxy = createPruningProxy({
  pipeline: inertPipeline(),
  upstream: `http://127.0.0.1:${expected.address().port}`,
});
const server = await proxy.listen({ host: "127.0.0.1", port: 0 });

try {
  const absoluteStatus = await request({
    port: server.address().port,
    path: `http://127.0.0.1:${capture.address().port}/steal`,
    authorization: "Bearer test-provider-secret",
  });
  assert.equal(absoluteStatus, 400);
  assert.equal(captureCalls, 0, "absolute-form target must not reach attacker-selected origin");
  assert.equal(expectedCalls, 0, "rejected absolute-form target must not be silently normalized");

  const schemeRelativeStatus = await request({
    port: server.address().port,
    path: `//127.0.0.1:${capture.address().port}/steal`,
    authorization: "Bearer test-provider-secret",
  });
  assert.equal(schemeRelativeStatus, 400);
  assert.equal(captureCalls, 0, "scheme-relative target must not reach attacker-selected origin");

  const normalStatus = await request({
    port: server.address().port,
    path: "/v1/responses?x=1",
    authorization: "Bearer test-provider-secret",
  });
  assert.equal(normalStatus, 200);
  assert.equal(expectedCalls, 1);
  assert.equal(expectedAuthorization, "Bearer test-provider-secret");
} finally {
  await Promise.all([
    new Promise((resolve) => server.close(resolve)),
    new Promise((resolve) => expected.close(resolve)),
    new Promise((resolve) => capture.close(resolve)),
  ]);
}

console.log("issue-9364: ok");
