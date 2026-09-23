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

test("#9377 consumes Connection-nominated request and response headers", async () => {
  let captured = null;
  const upstream = http.createServer((req, res) => {
    captured = { ...req.headers };
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        Connection: "X-Upstream-Hop, x-Upstream-Two",
        "X-Upstream-Hop": "private-one",
        "X-Upstream-Two": "private-two",
        "X-End-To-End-Response": "keep-response",
      });
      res.end("{}");
    });
  });
  const upstreamPort = await listen(upstream);
  const proxy = createPruningProxy({
    pipeline: inertPipeline(),
    upstream: `http://127.0.0.1:${upstreamPort}`,
    maxBodyBytes: 4096,
  });
  const server = await proxy.listen({ host: "127.0.0.1", port: 0 });

  try {
    const response = await new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: server.address().port,
        method: "POST",
        path: "/v1/responses",
        headers: {
          Connection: "keep-alive, X-Hop-Secret, x-Hop-Two",
          "X-Hop-Secret": "must-not-cross",
          "X-Hop-Two": "must-not-cross-either",
          "X-End-To-End": "keep-request",
          Authorization: "Bearer upstream-key",
          "Content-Type": "application/json",
          "Content-Length": "2",
        },
      }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end("{}");
    });

    assert.equal(response.status, 200);
    assert.ok(captured);
    // Node's agent may add its own `Connection: keep-alive`; the client's
    // nominated tokens must never be forwarded.
    assert.doesNotMatch(String(captured.connection ?? ""), /x-hop/i);
    assert.equal(captured["x-hop-secret"], undefined);
    assert.equal(captured["x-hop-two"], undefined);
    assert.equal(captured["x-end-to-end"], "keep-request");
    assert.equal(captured.authorization, "Bearer upstream-key");

    assert.doesNotMatch(String(response.headers.connection ?? ""), /x-upstream/i);
    assert.equal(response.headers["x-upstream-hop"], undefined);
    assert.equal(response.headers["x-upstream-two"], undefined);
    assert.equal(response.headers["x-end-to-end-response"], "keep-response");
  } finally {
    server.close();
    upstream.close();
  }
});

test("#9377 ignores malformed Connection tokens without removing unrelated end-to-end fields", async () => {
  let captured = null;
  const upstream = http.createServer((req, res) => {
    captured = { ...req.headers };
    req.resume();
    req.on("end", () => res.writeHead(200).end("{}"));
  });
  const upstreamPort = await listen(upstream);
  const proxy = createPruningProxy({
    pipeline: inertPipeline(),
    upstream: `http://127.0.0.1:${upstreamPort}`,
    maxBodyBytes: 4096,
  });
  const server = await proxy.listen({ host: "127.0.0.1", port: 0 });
  try {
    const response = await new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: server.address().port,
        method: "POST",
        path: "/v1/responses",
        headers: {
          Connection: "X-Valid, bad token",
          "X-Valid": "drop",
          "X-End-To-End": "keep",
          "Content-Length": "2",
        },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(response, 200);
    assert.equal(captured["x-valid"], undefined);
    assert.equal(captured["x-end-to-end"], "keep");
  } finally {
    server.close();
    upstream.close();
  }
});
