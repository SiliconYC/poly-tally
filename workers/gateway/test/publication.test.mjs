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
  GATEWAY_PASSWORD: "fixture-proxy-password-not-a-real-secret-123456789",
  READ_PAT: "fake-read-pat",
  WRITE_PAT: "fake-write-pat",
  GATEWAY_RECEIPT_KEY: "fake-receipt-key-not-real-12345678901234567890",
  ALLOWED_REPOSITORIES: '["SiliconYC/poly-tally"]',
};
function upstream(baselines = []) {
  let ref = "1".repeat(40),
    tree = "2".repeat(40),
    counter = 3,
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
    bootstrap: { policy: policy.configSha256, baselines },
    setStateEntry(entry) {
      entries = entries.filter((e) => e.path !== entry.path);
      if (entry.sha) {
        const content = JSON.stringify(entry.data);
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
      assert.equal(o.headers.get("Authorization"), "Bearer fake-write-pat");
      assert.ok(
        url.startsWith("https://api.github.com/repos/SiliconYC/poly-tally/"),
      );
      const path = url.split("/poly-tally")[1];
      if (o.method === "GET") {
        if (path === "/git/ref/heads/tally-state")
          return Response.json({ object: { sha: ref } });
        if (path.startsWith("/git/commits/"))
          return Response.json({ tree: { sha: tree } });
        if (path.startsWith("/git/trees/"))
          return Response.json({ tree: entries, truncated: false });
        if (path.startsWith("/git/blobs/")) {
          const sha = path.split("/").at(-1);
          return Response.json({
            sha,
            encoding: "base64",
            content: Buffer.from(blobs.get(sha)).toString("base64"),
          });
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
async function call(api, path, body, headers = {}) {
  const r = await worker.fetch(
    new Request(`https://gateway.example/publish/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GATEWAY_PASSWORD}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
    { fetcher: api.fetcher, policy, bootstrap: api.bootstrap },
  );
  return { status: r.status, body: await r.json() };
}
async function prepared(api, initial, change, expectedStatus = 200) {
  let r = initial
    ? { status: 200, body: { receipt: initial } }
    : await call(api, "start", {});
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
  const first = await call(api, "start", {});
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
    createHmac("sha256", env.GATEWAY_RECEIPT_KEY)
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
test("current legacy baseline requires exact reviewed bootstrap SHAs; drift and policy changes fail closed", async () => {
  const { priv } = fixtures(),
    api = upstream([
      { path: "private-metrics.json", sha: "a".repeat(40), data: priv },
    ]);
  assert.equal((await call(api, "start", {})).status, 200);
  api.bootstrap.baselines[0] = {
    ...api.bootstrap.baselines[0],
    sha: "b".repeat(40),
  };
  assert.equal((await call(api, "start", {})).status, 409);
  api.bootstrap = { policy: policy.configSha256, baselines: [] };
  assert.equal((await call(api, "start", {})).status, 409);
  api.bootstrap = {
    policy: "old",
    baselines: [
      { path: "private-metrics.json", sha: "a".repeat(40), data: priv },
    ],
  };
  assert.equal((await call(api, "start", {})).status, 409);
});
test("no configured bootstrap and no signed receipt cannot initialize publication", async () => {
  const api = upstream();
  api.bootstrap = undefined;
  assert.equal((await call(api, "start", {})).status, 409);
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
  api.bootstrap = null;
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
  assert.equal((await call(api, "start", {})).status, 403);
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
    const api = upstream([{ path, sha: "a".repeat(40), data: priv }]);
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
