import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import worker from "../src/handler.mjs";
import { fixtures, policy } from "./fixtures.mjs";
import {
  snapshotChunks,
  blobBody,
} from "../../../scripts/gateway-protocol.mjs";
const env = {
  GATEWAY_KEY: "fixture-proxy-password-not-a-real-secret-123456789",
  GITHUB_READ_TOKEN: "fake-read-pat",
  GITHUB_PUBLISH_TOKEN: "fake-write-pat",
  ALLOWED_REPOSITORIES: '["SiliconYC/poly-tally"]',
};
function upstream(baselines = []) {
  const { priv } = fixtures(),
    rebuilt = structuredClone(priv);
  rebuilt.completeness.complete = false;
  rebuilt.completeness.discoveryComplete = false;
  baselines = [
    ...new Map(
      [
        { path: "private-metrics.json", data: priv },
        { path: "rebuilt-private-metrics.json", data: rebuilt },
        ...baselines,
      ].map((b) => [b.path, b]),
    ).values(),
  ];
  baselines = baselines.map((b) => ({
    ...b,
    sha: createHash("sha1")
      .update(`blob ${Buffer.byteLength(JSON.stringify(b.data))}\0`)
      .update(JSON.stringify(b.data))
      .digest("hex"),
  }));
  let ref = "1".repeat(40),
    tree = "2".repeat(40),
    counter = 3,
    parents = [],
    entries = baselines.map((b) => ({
      path: b.path,
      sha: b.sha,
      type: "blob",
      mode: "100644",
      size: Buffer.byteLength(JSON.stringify(b.data)),
    }));
  const writes = [],
    blobs = new Map(baselines.map((b) => [b.sha, JSON.stringify(b.data)]));
  return {
    writes,
    blobs,
    setStateEntry(entry) {
      entries = entries.filter((e) => e.path !== entry.path);
      if (entry.sha) {
        const content = entry.raw ?? JSON.stringify(entry.data);
        blobs.set(entry.sha, content);
        entries.push({
          path: entry.path,
          sha: entry.sha,
          type: "blob",
          mode: "100644",
          size: Buffer.byteLength(content),
        });
      }
    },
    changeRef() {
      ref = "f".repeat(40);
    },
    fetcher: async (url, o) => {
      assert.equal(o.redirect, "manual");
      assert.equal(
        o.headers.get("Authorization"),
        o.method === "GET" ? "Bearer fake-read-pat" : "Bearer fake-write-pat",
      );
      assert.ok(
        url.startsWith("https://api.github.com/repos/SiliconYC/poly-tally/"),
      );
      const path = url.split("/poly-tally")[1];
      if (o.method === "GET") {
        if (path === "/git/ref/heads/tally-state")
          return Response.json({ object: { sha: ref } });
        if (path.startsWith("/git/commits/"))
          return Response.json({
            tree: { sha: tree },
            parents: parents.map((sha) => ({ sha })),
          });
        if (path.startsWith("/git/trees/"))
          return Response.json({ tree: entries, truncated: false });
        if (path.startsWith("/git/blobs/")) {
          const sha = path.split("/").at(-1);
          assert.match(o.headers.get("Accept"), /raw/);
          return new Response(blobs.get(sha));
        }
        assert.fail(path);
      }
      writes.push({
        path,
        body: JSON.parse(
          typeof o.body === "string"
            ? o.body
            : new TextDecoder().decode(o.body),
        ),
      });
      const body = writes.at(-1).body;
      if (path === "/git/blobs") {
        const sha = createHash("sha1")
          .update(`blob ${Buffer.byteLength(body.content)}\0`)
          .update(body.content)
          .digest("hex");
        blobs.set(sha, body.content);
        return Response.json({ sha });
      }
      if (path === "/git/trees") {
        assert.deepEqual(
          body.tree.map((x) => x.path),
          ["public-stats.json", "private-metrics.json", "gateway-receipt.json"],
        );
        entries = [
          ...entries.filter((e) => !body.tree.some((n) => n.path === e.path)),
          ...body.tree.map((e) => ({
            ...e,
            size: Buffer.byteLength(blobs.get(e.sha)),
          })),
        ];
        tree = "3".repeat(40);
        return Response.json({ sha: tree });
      }
      if (path === "/git/commits") {
        assert.deepEqual(body.parents, [ref]);
        parents = body.parents;
        return Response.json({ sha: "4".repeat(40) });
      }
      if (path === "/git/refs/heads/tally-state") {
        assert.equal(body.force, false);
        ref = body.sha;
        return Response.json({ object: { sha: ref } });
      }
      if (path === "/actions/workflows/publish-snapshot.yml/dispatches") {
        assert.equal(body.ref, "dev");
        assert.deepEqual(Object.keys(body.inputs).sort(), [
          "private_metrics_blob_sha",
          "public_stats_blob_sha",
          "snapshot_commit",
        ]);
        return new Response(null, { status: 204 });
      }
      assert.fail(path);
    },
  };
}
async function call(api, path, body, headers = {}, config = env) {
  const r = await worker.fetch(
    new Request(`https://gateway.example/publish/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GATEWAY_KEY}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    config,
    { fetcher: api.fetcher, policy },
  );
  return { status: r.status, body: await r.json() };
}
async function prepared(api, initial, change, expectedStatus = 200) {
  let r = initial
    ? {
        status: 200,
        body: {
          receipt: initial,
          baselineCount: JSON.parse(
            Buffer.from(initial.split(".")[0], "base64url"),
          ).pendingBaselines.length,
        },
      }
    : await call(api, "start", {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  while (r.body.baselineCount)
    r = await call(api, "baseline", { receipt: r.body.receipt });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let receipt = r.body.receipt;
  const f = fixtures();
  if (change) change(f);
  const { pub, priv } = f;
  for (const [kind, data] of [
    ["public", pub],
    ["private", priv],
  ])
    for (const chunk of snapshotChunks(data, kind)) {
      r = await call(api, "chunk", { receipt, chunk });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      receipt = r.body.receipt;
    }
  r = await call(api, "seal", { receipt });
  assert.equal(r.status, expectedStatus, JSON.stringify(r.body));
  return { ...r.body, pub, priv };
}
test("all writes are sealed canonical snapshots, fixed tally-state commit and one snapshot-only workflow", async () => {
  const api = upstream(),
    s = await prepared(api),
    uploaded = {};
  for (const [kind, data] of [
    ["public", s.pub],
    ["private", s.priv],
  ]) {
    const r = await call(api, "upload", blobBody(data), {
      "X-Poly-Receipt": s[kind],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    uploaded[kind] = r.body.receipt;
  }
  const committed = await call(api, "commit", {
    ...uploaded,
    selection: s.selection,
  });
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  assert.equal(api.writes.filter((x) => x.path === "/git/blobs").length, 3);
  const dispatch = await call(api, "dispatch", {
    receipt: committed.body.receipt,
  });
  assert.equal(dispatch.status, 200, JSON.stringify(dispatch.body));
});
test("unsealed, forged, modified or expired receipts never call a write endpoint", async () => {
  const api = upstream(),
    s = await prepared(api);
  for (const receipt of ["forged", s.public.slice(0, -3) + "abc"]) {
    const r = await call(api, "upload", blobBody(s.pub), {
      "X-Poly-Receipt": receipt,
    });
    assert.equal(r.status, 403);
  }
  const altered = await call(
    api,
    "upload",
    blobBody(s.pub).replace("SiliconYC/public", "SiliconYC/SECRET"),
    { "X-Poly-Receipt": s.public },
  );
  assert.equal(altered.status, 403);
  assert.equal(api.writes.length, 0);
});
test("unsupported routes, caller refs and incomplete batches fail closed", async () => {
  const api = upstream();
  for (const path of ["api", "blobs", "refs", "dispatch?ref=main"]) {
    const r = await call(api, path, { ref: "main" });
    assert.equal(r.status, 403);
  }
  let first = await call(api, "start", {});
  while (first.body.baselineCount)
    first = await call(api, "baseline", { receipt: first.body.receipt });
  const sealed = await call(api, "seal", { receipt: first.body.receipt });
  assert.equal(sealed.status, 400);
  assert.equal(api.writes.length, 0);
});
test("concurrent durable branch change blocks final commit rather than forcing overwrite", async () => {
  const api = upstream(),
    s = await prepared(api),
    uploaded = {};
  for (const [kind, data] of [
    ["public", s.pub],
    ["private", s.priv],
  ])
    uploaded[kind] = (
      await call(api, "upload", blobBody(data), { "X-Poly-Receipt": s[kind] })
    ).body.receipt;
  api.changeRef();
  const r = await call(api, "commit", { ...uploaded, selection: s.selection });
  assert.equal(r.status, 409);
  assert.equal(
    api.writes.filter((x) => x.path === "/git/refs/heads/tally-state").length,
    0,
  );
});

function retime(token, expires) {
  const data = JSON.parse(Buffer.from(token.split(".")[0], "base64url"));
  data.expires = expires;
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return (
    payload +
    "." +
    createHmac(
      "sha256",
      createHash("sha256")
        .update(
          `poly-tally/gateway/receipt-key/v2\0${env.GITHUB_PUBLISH_TOKEN}`,
        )
        .digest(),
    )
      .update(Buffer.from(payload, "base64url"))
      .digest("base64url")
  );
}
test("expired progress/upload/blob/dispatch capabilities fail without a new write", async () => {
  const api = upstream(),
    first = await call(api, "start", {});
  assert.equal(
    (await call(api, "seal", { receipt: retime(first.body.receipt, 1) }))
      .status,
    403,
  );
  const s = await prepared(api);
  assert.equal(
    (
      await call(api, "upload", blobBody(s.pub), {
        "X-Poly-Receipt": retime(s.public, 1),
      })
    ).status,
    403,
  );
  const uploaded = {};
  for (const [kind, data] of [
    ["public", s.pub],
    ["private", s.priv],
  ])
    uploaded[kind] = (
      await call(api, "upload", blobBody(data), { "X-Poly-Receipt": s[kind] })
    ).body.receipt;
  const before = api.writes.length;
  assert.equal(
    (
      await call(api, "commit", {
        ...uploaded,
        public: retime(uploaded.public, 1),
        selection: s.selection,
      })
    ).status,
    403,
  );
  assert.equal(api.writes.length, before);
  const committed = await call(api, "commit", {
    ...uploaded,
    selection: s.selection,
  });
  assert.equal(
    (
      await call(api, "dispatch", {
        receipt: retime(committed.body.receipt, 1),
      })
    ).status,
    403,
  );
});
test("same-batch forks cannot mix differently validated snapshot pairs", async () => {
  const api = upstream(),
    first = await call(api, "start", {}),
    a = await prepared(api, first.body.receipt),
    b = await prepared(api, first.body.receipt, (f) => {
      f.pub.repositories[0].history[0].metrics = {
        ...f.pub.repositories[0].history[0].metrics,
        code: 9,
      };
      f.pub.summary.code = 9;
    });
  const pub = (
      await call(api, "upload", blobBody(a.pub), { "X-Poly-Receipt": a.public })
    ).body.receipt,
    priv = (
      await call(api, "upload", blobBody(b.priv), {
        "X-Poly-Receipt": b.private,
      })
    ).body.receipt;
  assert.equal(
    (
      await call(api, "commit", {
        public: pub,
        private: priv,
        selection: a.selection,
      })
    ).status,
    403,
  );
});
test("server baseline step refuses a changed durable ref", async () => {
  const { priv } = fixtures(),
    api = upstream([{ path: "private-metrics.json", data: priv }]);
  const first = await call(api, "start", {});
  assert.equal(first.body.baselineCount, 2);
  api.changeRef();
  assert.equal(
    (await call(api, "baseline", { receipt: first.body.receipt })).status,
    409,
  );
  assert.equal(api.writes.length, 0);
});
test("signed compact baseline survives restart, but tampering or rebuilt changes is rejected", async () => {
  const api = upstream(),
    s = await prepared(api),
    uploaded = {};
  for (const [kind, data] of [
    ["public", s.pub],
    ["private", s.priv],
  ])
    uploaded[kind] = (
      await call(api, "upload", blobBody(data), { "X-Poly-Receipt": s[kind] })
    ).body.receipt;
  assert.equal(
    (await call(api, "commit", { ...uploaded, selection: s.selection })).status,
    200,
  );
  assert.equal((await call(api, "start", {})).status, 200);
  const saved = api.writes.find(
    (x) =>
      x.path === "/git/blobs" &&
      typeof x.body.content === "string" &&
      !x.body.content.startsWith("{"),
  ).body.content;
  const sha = createHash("sha1")
    .update(`blob ${Buffer.byteLength(saved)}\0`)
    .update(saved)
    .digest("hex");
  api.blobs.set(sha, saved.slice(0, -1) + (saved.endsWith("x") ? "y" : "x"));
  assert.equal((await call(api, "start", {})).status, 502);
});
test("oversized body and unsupported upload encoding never reach GitHub", async () => {
  const api = upstream(),
    s = await prepared(api);
  assert.equal(
    (
      await call(api, "upload", "x".repeat(1048577), {
        "X-Poly-Receipt": s.public,
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await call(api, "upload", blobBody(s.pub), {
        "X-Poly-Receipt": s.public,
        "Content-Encoding": "gzip",
      })
    ).status,
    400,
  );
  assert.equal(api.writes.length, 0);
});
test("write redirects are not followed, disclosed or treated as a successful blob", async () => {
  const api = upstream(),
    s = await prepared(api);
  api.fetcher = async () =>
    new Response(null, {
      status: 302,
      headers: { Location: "https://evil.test/" },
    });
  const r = await call(api, "upload", blobBody(s.pub), {
    "X-Poly-Receipt": s.public,
  });
  assert.equal(r.status, 502);
  assert.doesNotMatch(JSON.stringify(r.body), /evil/);
});

test("known scope cannot be reset by deleting durable private state or replaying an old signed receipt", async () => {
  const api = upstream(),
    s = await prepared(api),
    uploaded = {};
  for (const [kind, data] of [
    ["public", s.pub],
    ["private", s.priv],
  ])
    uploaded[kind] = (
      await call(api, "upload", blobBody(data), { "X-Poly-Receipt": s[kind] })
    ).body.receipt;
  assert.equal(
    (await call(api, "commit", { ...uploaded, selection: s.selection })).status,
    200,
  );
  api.setStateEntry({ path: "private-metrics.json" });
  assert.equal((await call(api, "start", {})).status, 409);
  api.setStateEntry({
    path: "private-metrics.json",
    sha: "e".repeat(40),
    data: s.priv,
  });
  assert.equal((await call(api, "start", {})).status, 409);
});

test("reviewed private and rebuilt scope/time baselines cannot be rolled back", async () => {
  for (const path of ["private-metrics.json", "rebuilt-private-metrics.json"]) {
    const { priv } = fixtures();
    const extra = structuredClone(priv.repositories[0]);
    extra.sourceKey = "f".repeat(16);
    extra.id = "private-" + extra.sourceKey;
    extra.name = "SiliconYC/retained";
    priv.repositories.push(extra);
    priv.collection.repositories = 2;
    priv.completeness.expectedRepositories =
      priv.completeness.scannedRepositories = 3;
    if (path === "rebuilt-private-metrics.json") {
      priv.completeness.complete = false;
      priv.completeness.discoveryComplete = false;
    }
    const api = upstream([{ path, data: priv }]);
    await prepared(api, undefined, undefined, 400);
    assert.equal(api.writes.length, 0);
  }
  const { priv } = fixtures();
  priv.generatedAt = "2026-10-25T00:00:00Z";
  const api = upstream([
    { path: "private-metrics.json", sha: "a".repeat(40), data: priv },
  ]);
  await prepared(api, undefined, undefined, 400);
  assert.equal(api.writes.length, 0);
});

test("lost final PATCH response can recover exact commit selectors without any additional write", async () => {
  const api = upstream(),
    s = await prepared(api),
    uploaded = {};
  for (const [kind, data] of [
    ["public", s.pub],
    ["private", s.priv],
  ])
    uploaded[kind] = (
      await call(api, "upload", blobBody(data), { "X-Poly-Receipt": s[kind] })
    ).body.receipt;
  const payload = { ...uploaded, selection: s.selection },
    old = api.fetcher;
  api.fetcher = async (url, options) => {
    const result = await old(url, options);
    if (options.method === "PATCH")
      throw new Error("fake lost response AFTER confirmed update");
    return result;
  };
  assert.equal((await call(api, "commit", payload)).status, 502);
  const count = api.writes.length;
  const recovered = await call(api, "status", payload);
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.match(recovered.body.snapshotCommit, /^[a-f0-9]{40}$/);
  assert.equal(api.writes.length, count);
  assert.equal(
    (await call(api, "dispatch", { receipt: recovered.body.receipt })).status,
    200,
  );
});
test("explicit receipt-key rotation recovery requires both fixed baselines and current-commit confirmation", async () => {
  const { priv } = fixtures(),
    rebuilt = structuredClone(priv);
  rebuilt.completeness.complete = false;
  rebuilt.completeness.discoveryComplete = false;
  const api = upstream([
    { path: "private-metrics.json", data: priv },
    { path: "rebuilt-private-metrics.json", data: rebuilt },
  ]);
  const stale = await call(api, "recover", {
    expectedCurrentCommit: "0".repeat(40),
  });
  assert.equal(stale.status, 409);
  const start = await call(api, "recover", {
    expectedCurrentCommit: "1".repeat(40),
  });
  assert.equal(start.status, 200);
  assert.equal(start.body.baselineCount, 2);
  let next = start;
  while (next.body.baselineCount)
    next = await call(api, "baseline", { receipt: next.body.receipt });
  assert.equal(next.status, 200);
  api.setStateEntry({ path: "rebuilt-private-metrics.json" });
  assert.equal(
    (await call(api, "recover", { expectedCurrentCommit: "1".repeat(40) }))
      .status,
    409,
  );
  assert.equal(api.writes.length, 0);
});

test("actual publish-token rotation fails ordinary start and explicit server recovery revalidates both blobs", async () => {
  const api = upstream(),
    s = await prepared(api),
    uploaded = {};
  for (const [kind, data] of [
    ["public", s.pub],
    ["private", s.priv],
  ])
    uploaded[kind] = (
      await call(api, "upload", blobBody(data), { "X-Poly-Receipt": s[kind] })
    ).body.receipt;
  const saved = await call(api, "commit", {
    ...uploaded,
    selection: s.selection,
  });
  assert.equal(saved.status, 200);
  const rotated = { ...env, GITHUB_PUBLISH_TOKEN: "fake-rotated-write-token" },
    before = api.writes.length;
  assert.equal((await call(api, "start", {}, {}, rotated)).status, 403);
  let result = await call(
    api,
    "recover",
    { expectedCurrentCommit: saved.body.snapshotCommit },
    {},
    rotated,
  );
  assert.equal(result.status, 200);
  while (result.body.baselineCount)
    result = await call(
      api,
      "baseline",
      { receipt: result.body.receipt },
      {},
      rotated,
    );
  assert.equal(result.status, 200);
  assert.equal(api.writes.length, before);
});
test("recovery cannot use a still-verifiable old receipt to permit scope rollback", async () => {
  const api = upstream(),
    s = await prepared(api),
    uploaded = {};
  for (const [kind, data] of [
    ["public", s.pub],
    ["private", s.priv],
  ])
    uploaded[kind] = (
      await call(api, "upload", blobBody(data), { "X-Poly-Receipt": s[kind] })
    ).body.receipt;
  const saved = await call(api, "commit", {
    ...uploaded,
    selection: s.selection,
  });
  assert.equal(saved.status, 200);
  const reduced = structuredClone(s.priv);
  reduced.repositories = [];
  reduced.collection.repositories = 0;
  const bytes = JSON.stringify(reduced),
    sha = createHash("sha1")
      .update(`blob ${Buffer.byteLength(bytes)}\0`)
      .update(bytes)
      .digest("hex");
  api.setStateEntry({ path: "private-metrics.json", sha, data: reduced });
  assert.equal((await call(api, "start", {})).status, 409);
  let result = await call(api, "recover", {
    expectedCurrentCommit: saved.body.snapshotCommit,
  });
  assert.equal(result.status, 200);
  while (result.body.baselineCount && result.status === 200)
    result = await call(api, "baseline", { receipt: result.body.receipt });
  assert.equal(result.status, 409);
});

test("cryptographically valid prior-policy receipt remains a scope constraint during explicit recovery", async () => {
  const api = upstream(),
    s = await prepared(api),
    uploaded = {};
  for (const [kind, data] of [
    ["public", s.pub],
    ["private", s.priv],
  ])
    uploaded[kind] = (
      await call(api, "upload", blobBody(data), { "X-Poly-Receipt": s[kind] })
    ).body.receipt;
  const saved = await call(api, "commit", {
    ...uploaded,
    selection: s.selection,
  });
  assert.equal(saved.status, 200);
  const token = api.writes.find(
    (x) => x.path === "/git/blobs" && !x.body.content.startsWith("{"),
  ).body.content;
  const value = JSON.parse(Buffer.from(token.split(".")[0], "base64url"));
  value.policy = "d".repeat(64);
  const payload = Buffer.from(JSON.stringify(value)),
    key = createHash("sha256")
      .update(`poly-tally/gateway/receipt-key/v2\0${env.GITHUB_PUBLISH_TOKEN}`)
      .digest();
  const raw =
    payload.toString("base64url") +
    "." +
    createHmac("sha256", key).update(payload).digest("base64url");
  const receiptSha = createHash("sha1")
    .update(`blob ${Buffer.byteLength(raw)}\0`)
    .update(raw)
    .digest("hex");
  api.setStateEntry({ path: "gateway-receipt.json", sha: receiptSha, raw });
  const reduced = structuredClone(s.priv);
  reduced.repositories = [];
  reduced.collection.repositories = 0;
  const bytes = JSON.stringify(reduced),
    sha = createHash("sha1")
      .update(`blob ${Buffer.byteLength(bytes)}\0`)
      .update(bytes)
      .digest("hex");
  api.setStateEntry({ path: "private-metrics.json", sha, data: reduced });
  let result = await call(api, "recover", {
    expectedCurrentCommit: saved.body.snapshotCommit,
  });
  assert.equal(result.status, 200);
  while (result.body.baselineCount && result.status === 200)
    result = await call(api, "baseline", { receipt: result.body.receipt });
  assert.equal(result.status, 409);
});
