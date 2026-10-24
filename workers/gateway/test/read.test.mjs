import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/handler.mjs";
const env = {
  GATEWAY_PASSWORD: "fixture-proxy-password-not-a-real-secret-123456789",
  READ_PAT: "fake-read-pat",
  WRITE_PAT: "fake-write-pat",
  GATEWAY_RECEIPT_KEY: "fake-receipt-key-not-real-12345678901234567890",
  ALLOWED_REPOSITORIES: '["SiliconYC/poly-tally","SiliconYC/private-test"]',
};
const request = (path, options = {}) =>
  new Request(`https://gateway.example${path}`, {
    headers: {
      Authorization: `Bearer ${env.GATEWAY_PASSWORD}`,
      ...options.headers,
    },
    ...options,
  });
const run = (path, fetcher, options = {}) =>
  worker.fetch(request(path, options), env, { fetcher });
test("unauthenticated requests fail before any upstream request", async () => {
  const r = await worker.fetch(
    new Request("https://gateway.example/api/users/SiliconYC"),
    env,
    {
      fetcher() {
        assert.fail();
      },
    },
  );
  assert.equal(r.status, 401);
});
test("fixed API route uses read credential and projects only permitted metadata", async () => {
  let seen;
  const r = await run(
    "/api/repos/SiliconYC/poly-tally",
    async (url, options) => {
      seen = { url, options };
      return Response.json({
        id: 1,
        name: "poly-tally",
        full_name: "SiliconYC/poly-tally",
        clone_url: "https://github.com/SiliconYC/poly-tally.git",
        default_branch: "dev",
        private: false,
        archived: false,
        fork: false,
        size: 123,
        owner: { login: "SiliconYC" },
        description: "not needed",
      });
    },
  );
  assert.equal(r.status, 200);
  assert.equal(seen.url, "https://api.github.com/repos/SiliconYC/poly-tally");
  assert.equal(
    seen.options.headers.get("Authorization"),
    "Bearer fake-read-pat",
  );
  assert.equal(seen.options.redirect, "manual");
  assert.equal((await r.json()).description, undefined);
});
test("paths, methods, query duplicates, encoded traversal, receive-pack and unknown repos fail closed", async () => {
  for (const [path, method] of [
    ["/api/repos/other/repo", "GET"],
    ["/api/repos/SiliconYC/poly-tally/contents/x", "GET"],
    ["/api/repos/SiliconYC/poly-tally", "POST"],
    ["/git/SiliconYC/poly-tally.git/git-receive-pack", "POST"],
    ["/git/SiliconYC/poly-tally.git/info/refs?service=git-receive-pack", "GET"],
    [
      "/git/SiliconYC/poly-tally.git/info/refs?service=git-upload-pack&service=git-upload-pack",
      "GET",
    ],
    ["/git/SiliconYC/unknown.git/git-upload-pack", "POST"],
    [
      "/git/SiliconYC/poly-tally.git%2f/info/refs?service=git-upload-pack",
      "GET",
    ],
    ["/api/repos/SiliconYC/poly-tally?url=https://evil.test", "GET"],
    ["/api/repos/SiliconYC/poly-tally%2f..%2fprivate-test", "GET"],
  ]) {
    const r = await run(path, () => assert.fail("upstream called"), { method });
    assert.equal(r.status, 403, path);
  }
});
test("upstream redirects are never followed or exposed", async () => {
  const r = await run(
    "/git/SiliconYC/poly-tally.git/info/refs?service=git-upload-pack",
    async () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://evil.test/secret" },
      }),
  );
  assert.equal(r.status, 502);
  assert.equal(r.headers.get("Location"), null);
});
test("smart Git response streams without buffering and strips all unapproved headers", async () => {
  let controller;
  const stream = new ReadableStream({
    start(c) {
      controller = c;
    },
  });
  const r = await run(
    "/git/SiliconYC/poly-tally.git/git-upload-pack",
    async (url, o) => {
      assert.equal(
        url,
        "https://github.com/SiliconYC/poly-tally.git/git-upload-pack",
      );
      assert.equal(o.headers.get("Git-Protocol"), "version=2");
      assert.equal(
        o.headers.get("Authorization"),
        "Basic " + btoa("x-access-token:fake-read-pat"),
      );
      assert.equal(o.headers.get("X-Injected"), null);
      return new Response(stream, {
        headers: {
          "Content-Type": "application/x-git-upload-pack-result",
          "Set-Cookie": "secret",
          "X-Token": "secret",
        },
      });
    },
    {
      method: "POST",
      body: "0000",
      headers: {
        Authorization: `Bearer ${env.GATEWAY_PASSWORD}`,
        "Content-Type": "application/x-git-upload-pack-request",
        "Git-Protocol": "version=2",
        "X-Injected": "bad",
      },
      duplex: "half",
    },
  );
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Set-Cookie"), null);
  const reader = r.body.getReader();
  controller.enqueue(new Uint8Array([1, 2, 3]));
  assert.deepEqual((await reader.read()).value, new Uint8Array([1, 2, 3]));
  controller.close();
  assert.equal((await reader.read()).done, true);
});
test("pagination is bounded and rewritten back to gateway with no PAT/header leakage", async () => {
  const r = await run(
    "/api/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&per_page=100",
    async (url) => {
      assert.match(url, /per_page=10/);
      assert.match(url, /affiliation=owner/);
      return Response.json([], {
        headers: {
          Link: '<https://api.github.com/user/repos?affiliation=owner&per_page=10&page=2>; rel="next"',
        },
      });
    },
  );
  assert.match(
    r.headers.get("Link"),
    /^<https:\/\/gateway.example\/api\/user\/repos\?/,
  );
  assert.doesNotMatch(await r.text(), /fake-read|fixture-proxy/);
});
test("upstream errors are sanitized, never echo PAT or raw GitHub body", async () => {
  const r = await run(
    "/api/users/SiliconYC",
    async () => new Response("fake-read-pat raw secret", { status: 401 }),
  );
  assert.equal(r.status, 401);
  assert.doesNotMatch(await r.text(), /fake-read|raw secret/);
});
test("encoded slash is permitted only inside a validated branch leaf, never repository/path syntax", async () => {
  const r = await run(
    "/api/repos/SiliconYC/poly-tally/branches/feature%2Fmain",
    async (url) => {
      assert.equal(
        url,
        "https://api.github.com/repos/SiliconYC/poly-tally/branches/feature%2Fmain",
      );
      return Response.json({ commit: { sha: "a".repeat(40) } });
    },
  );
  assert.equal(r.status, 200);
  for (const branch of [
    "..%2fsecret",
    "a%2f..%2fb",
    "a%2f%2fb",
    "a%5cb",
    "a.lock",
    "a%2f.lock",
    "a%40%7bb",
  ]) {
    const bad = await run(
      "/api/repos/SiliconYC/poly-tally/branches/" + branch,
      () => assert.fail(),
    );
    assert.equal(bad.status, 403);
  }
});
test("rate limit hints survive sanitized error responses", async () => {
  const r = await run(
    "/api/users/SiliconYC",
    async () =>
      new Response("never expose", {
        status: 429,
        headers: {
          "Retry-After": "17",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": "1234",
          "X-Secret": "hidden",
        },
      }),
  );
  assert.equal(r.status, 429);
  assert.equal(r.headers.get("Retry-After"), "17");
  assert.equal(r.headers.get("X-RateLimit-Remaining"), "0");
  assert.equal(r.headers.get("X-Secret"), null);
});
test("discovery never silently hides or discloses a newly unauthorized repository", async () => {
  const r = await run("/api/user/repos", async () =>
    Response.json([
      {
        id: 7,
        full_name: "SiliconYC/new-private",
        owner: { login: "SiliconYC" },
        private: true,
      },
    ]),
  );
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "repository_authorization_required");
});
test("all upstream read requests negotiate identity to avoid hidden compression buffering", async () => {
  const r = await run("/api/users/SiliconYC", async (url, o) => {
    assert.equal(o.headers.get("Accept-Encoding"), "identity");
    return Response.json({ type: "User" });
  });
  assert.equal(r.status, 200);
});
test("owner-wide explicit scope allows future SiliconYC repos but no other owner", async () => {
  const owned = { ...env, ALLOWED_REPOSITORIES: '["SiliconYC/*"]' };
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return new Response("0000", {
      headers: {
        "Content-Type": "application/x-git-upload-pack-advertisement",
      },
    });
  };
  assert.equal(
    (
      await worker.fetch(
        request(
          "/git/SiliconYC/future-repo.git/info/refs?service=git-upload-pack",
        ),
        owned,
        { fetcher },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await worker.fetch(
        request("/git/other/future-repo.git/info/refs?service=git-upload-pack"),
        owned,
        { fetcher },
      )
    ).status,
    403,
  );
  assert.equal(calls, 1);
});
test("wrong READ_PAT owner cannot masquerade as an empty complete discovery", async () => {
  const r = await run("/api/user/repos", async () =>
    Response.json([{ full_name: "other/repo", owner: { login: "other" } }]),
  );
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "credential_owner_mismatch");
});
test("public health discloses no configuration and never makes an upstream request", async () => {
  const r = await worker.fetch(
    new Request("https://gateway.example/health"),
    env,
    { fetcher: () => assert.fail() },
  );
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    service: "poly-tally-gateway",
    version: 1,
  });
});
test("misconfigured shared read/write/proxy/receipt secrets fail closed without revealing values", async () => {
  for (const duplicate of [
    { WRITE_PAT: env.READ_PAT },
    { READ_PAT: env.GATEWAY_PASSWORD },
    { WRITE_PAT: env.GATEWAY_PASSWORD },
    { GATEWAY_RECEIPT_KEY: env.READ_PAT },
    { GATEWAY_RECEIPT_KEY: env.GATEWAY_PASSWORD },
  ]) {
    const r = await worker.fetch(
      request("/api/users/SiliconYC"),
      { ...env, ...duplicate },
      { fetcher: () => assert.fail() },
    );
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: "gateway_not_configured" });
  }
});

test("double-encoded branch components cannot survive validation for upstream re-decoding", async () => {
  for (const branch of [
    "feature%252fmain",
    "%252e%252e%252fprivate",
    "a%25252fb",
  ]) {
    const result = await run(
      "/api/repos/SiliconYC/poly-tally/branches/" + branch,
      () => assert.fail("ambiguous upstream path"),
    );
    assert.equal(result.status, 403);
  }
});
