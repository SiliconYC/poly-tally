import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker from "../src/handler.mjs";
import { fixtures, policy } from "./fixtures.mjs";
const env = {
  GITHUB_READ_TOKEN: "fake-read-token",
  GITHUB_PUBLISH_TOKEN: "fake-write-token",
  GATEWAY_KEY: "fake-gateway-password-012345678901234567890123456789",
};
const gitHash = (bytes) =>
  createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
function fakeState(data = fixtures().priv) {
  const bytes = Buffer.from(JSON.stringify(data)),
    sha = gitHash(bytes),
    calls = [];
  const rebuilt = structuredClone(fixtures().priv);
  rebuilt.completeness.complete = false;
  rebuilt.completeness.discoveryComplete = false;
  const rebuiltBytes = Buffer.from(JSON.stringify(rebuilt)),
    rebuiltSha = gitHash(rebuiltBytes);
  return {
    bytes,
    sha,
    calls,
    fetcher: async (url, options) => {
      const path = new URL(url).pathname.split("/poly-tally")[1];
      calls.push({ path, options });
      assert.equal(options.method, "GET");
      assert.equal(
        options.headers.get("Authorization"),
        "Bearer fake-read-token",
      );
      if (path === "/git/ref/heads/tally-state")
        return Response.json({ object: { sha: "1".repeat(40) } });
      if (path.startsWith("/git/commits/"))
        return Response.json({ tree: { sha: "2".repeat(40) } });
      if (path.startsWith("/git/trees/"))
        return Response.json({
          tree: [
            {
              path: "private-metrics.json",
              sha,
              type: "blob",
              mode: "100644",
              size: bytes.length,
            },
            {
              path: "rebuilt-private-metrics.json",
              sha: rebuiltSha,
              type: "blob",
              mode: "100644",
              size: rebuiltBytes.length,
            },
          ],
        });
      assert.ok(
        [`/git/blobs/${sha}`, `/git/blobs/${rebuiltSha}`].includes(path),
      );
      assert.match(options.headers.get("Accept"), /raw/);
      return new Response(path.endsWith(sha) ? bytes : rebuiltBytes);
    },
  };
}
async function call(api, action, body, config = env) {
  const response = await worker.fetch(
    new Request(`https://gateway.example/publish/${action}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.GATEWAY_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    config,
    { fetcher: api.fetcher, policy },
  );
  return { status: response.status, body: await response.json() };
}
test("three original Secret names bootstrap only server-fetched exact legacy blob, no client bytes", async () => {
  const api = fakeState();
  const start = await call(api, "start", {});
  assert.equal(start.status, 200);
  assert.equal(start.body.baselineCount, 2);
  const forbidden = await call(api, "baseline", {
    receipt: start.body.receipt,
    data: fixtures().priv,
  });
  assert.equal(forbidden.status, 400);
  const next = await call(api, "baseline", { receipt: start.body.receipt });
  assert.equal(next.status, 200);
  assert.equal(next.body.baselineCount, 1);
  assert.equal(api.calls.filter((c) => c.path.includes("/blobs/")).length, 1);
});
test("new snapshot chunks are forbidden while server baseline validation is pending", async () => {
  const api = fakeState(),
    start = await call(api, "start", {});
  assert.equal(start.status, 200);
  const next = await call(api, "chunk", {
    receipt: start.body.receipt,
    chunk: { action: "artifact", kind: "public", header: {} },
  });
  assert.equal(next.status, 409);
});
test("baseline byte hash mismatch and private schema additions are rejected before any write", async () => {
  for (const mutate of ["hash", "schema"]) {
    const data = fixtures().priv;
    if (mutate === "schema")
      data.repositories[0].privateSource = "FAKE_NOT_ALLOWED";
    const api = fakeState(data);
    if (mutate === "hash") {
      const old = api.fetcher;
      api.fetcher = async (url, options) =>
        new URL(url).pathname.includes("/blobs/")
          ? new Response("{}")
          : old(url, options);
    }
    const start = await call(api, "start", {});
    assert.equal(start.status, 200);
    const result = await call(api, "baseline", { receipt: start.body.receipt });
    assert.ok(result.status >= 400);
  }
});

test("declared oversized baseline cancels upstream stream before buffering body", async () => {
  const api = fakeState(),
    start = await call(api, "start", {});
  let canceled = false;
  const old = api.fetcher;
  api.fetcher = async (url, options) =>
    new URL(url).pathname.includes("/blobs/")
      ? new Response(
          new ReadableStream({
            cancel() {
              canceled = true;
            },
          }),
          { headers: { "Content-Length": String(1024 * 1024 + 1) } },
        )
      : old(url, options);
  const result = await call(api, "baseline", { receipt: start.body.receipt });
  assert.equal(result.status, 413);
  assert.equal(canceled, true);
});
test("initial migration never treats missing fixed baseline as a new empty scope", async () => {
  const api = fakeState(),
    old = api.fetcher;
  api.fetcher = async (url, options) =>
    new URL(url).pathname.includes("/trees/")
      ? Response.json({ tree: [] })
      : old(url, options);
  assert.equal((await call(api, "start", {})).status, 409);
});
