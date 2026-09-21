import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createPruningProxy } from "../jev-context/proxy/server.mjs";

function inertPipeline() {
  return { config: { usable: false, mode: "off", background: false } };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

function send({ port, body, headers = {}, chunks = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/v1/responses",
      headers,
    }, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (responseBody += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: responseBody }));
    });
    req.on("error", reject);
    if (chunks) {
      for (const chunk of chunks) req.write(chunk);
      req.end();
    } else {
      req.end(body);
    }
  });
}

async function fixture(limit = 1024) {
  const state = { calls: 0, bodies: [] };
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      state.calls += 1;
      state.bodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  const upstreamPort = await listen(upstream);
  const proxy = createPruningProxy({
    pipeline: inertPipeline(),
    upstream: `http://127.0.0.1:${upstreamPort}`,
    maxBodyBytes: limit,
  });
  const server = await proxy.listen({ host: "127.0.0.1", port: 0 });
  return {
    port: server.address().port,
    state,
    close() {
      server.close();
      upstream.close();
    },
  };
}

test("#9369 rejects a declared Content-Length above the configured limit before upstream I/O", async () => {
  const f = await fixture(1024);
  try {
    const body = "x".repeat(2048);
    const response = await send({
      port: f.port,
      body,
      headers: { "content-length": String(Buffer.byteLength(body)) },
    });
    assert.equal(response.status, 413);
    assert.equal(f.state.calls, 0);
  } finally {
    f.close();
  }
});

test("#9369 rejects chunked bodies when cumulative bytes cross the limit", async () => {
  const f = await fixture(1024);
  try {
    const response = await send({
      port: f.port,
      chunks: ["a".repeat(700), "b".repeat(400)],
      headers: { "content-type": "application/json" },
    });
    assert.equal(response.status, 413);
    assert.equal(f.state.calls, 0);
  } finally {
    f.close();
  }
});

test("#9369 accepts a body exactly at the configured byte limit", async () => {
  const f = await fixture(1024);
  try {
    const body = "z".repeat(1024);
    const response = await send({
      port: f.port,
      body,
      headers: { "content-length": String(Buffer.byteLength(body)) },
    });
    assert.equal(response.status, 200);
    assert.equal(f.state.calls, 1);
    assert.equal(f.state.bodies[0], body);
  } finally {
    f.close();
  }
});

test("#9369 keeps below-limit malformed JSON fail-open forwarding unchanged", async () => {
  const f = await fixture(1024);
  try {
    const body = "{not-json";
    const response = await send({
      port: f.port,
      body,
      headers: { "content-length": String(Buffer.byteLength(body)), "content-type": "application/json" },
    });
    assert.equal(response.status, 200);
    assert.equal(f.state.calls, 1);
    assert.equal(f.state.bodies[0], body);
  } finally {
    f.close();
  }
});
