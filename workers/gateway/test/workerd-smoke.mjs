// Isolated real workerd + real native Git, with ONLY fake credentials and a
// local git-http-backend fixture. Does not contact GitHub/Cloudflare accounts.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { bootstrap, policy } from "./synthetic-bootstrap.mjs";
import { publishGateway } from "../../../scripts/gateway-publish.mjs";
const directory = await mkdtemp(join(tmpdir(), "poly-gateway-workerd-"));
const env = {
  PATH: process.env.PATH,
  HOME: directory,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};
const fake = {
  GITHUB_READ_TOKEN: "fake-read-credential",
  GITHUB_PUBLISH_TOKEN: "fake-write-credential",
  GATEWAY_KEY: "fake-proxy-password-only-1234567890123456789012345",
  ALLOWED_REPOSITORIES: '["SiliconYC/*"]',
  LOCAL_TEST_ONLY: "true",
};
const git = (args, options = {}) =>
  execFileSync("git", ["-c", "credential.helper=", ...args], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
let mf, bridge;
let stateRef = bootstrap.sourceCommit,
  stateTree = "2".repeat(40),
  stateEntries = bootstrap.baselines.map((b) => ({
    path: b.path,
    sha: b.sha,
    mode: "100644",
    type: "blob",
    size: Buffer.byteLength(JSON.stringify(b.data)),
  }));
const blobs = new Map(
  bootstrap.baselines.map((b) => [b.sha, JSON.stringify(b.data)]),
);
let dispatched = 0,
  publicationRequests = 0;
async function publicationUpstream(request, url) {
  assert.equal(
    request.headers.get("Authorization"),
    "Bearer " +
      (request.method === "GET"
        ? fake.GITHUB_READ_TOKEN
        : fake.GITHUB_PUBLISH_TOKEN),
  );
  publicationRequests++;
  const path = url.pathname.replace("/repos/SiliconYC/poly-tally", "");
  if (request.method === "GET") {
    if (path === "/git/ref/heads/tally-state")
      return Response.json({ object: { sha: stateRef } });
    if (path.startsWith("/git/commits/"))
      return Response.json({ tree: { sha: stateTree } });
    if (path.startsWith("/git/trees/"))
      return Response.json({ tree: stateEntries, truncated: false });
    if (path.startsWith("/git/blobs/")) {
      const sha = path.split("/").at(-1);
      assert.match(request.headers.get("Accept"), /raw/);
      return new Response(blobs.get(sha));
    }
  }
  const body = await request.json();
  if (path === "/git/blobs") {
    const bytes = Buffer.from(body.content);
    const sha = createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    blobs.set(sha, body.content);
    return Response.json({ sha });
  }
  if (path === "/git/trees") {
    assert.deepEqual(
      body.tree.map((x) => x.path),
      ["public-stats.json", "private-metrics.json", "gateway-receipt.json"],
    );
    stateEntries = [
      ...stateEntries.filter((e) => !body.tree.some((n) => n.path === e.path)),
      ...body.tree.map((e) => ({
        ...e,
        size: Buffer.byteLength(blobs.get(e.sha)),
      })),
    ];
    stateTree = "3".repeat(40);
    return Response.json({ sha: stateTree });
  }
  if (path === "/git/commits") {
    assert.deepEqual(body.parents, [stateRef]);
    return Response.json({ sha: "4".repeat(40) });
  }
  if (path === "/git/refs/heads/tally-state") {
    assert.equal(body.force, false);
    stateRef = body.sha;
    return Response.json({ object: { sha: stateRef } });
  }
  if (path === "/actions/workflows/publish-snapshot.yml/dispatches") {
    assert.equal(body.ref, "dev");
    dispatched++;
    return new Response(null, { status: 204 });
  }
  throw new Error("Unexpected fixture API route");
}
let upstreamRequests = 0,
  uploadPackRequests = 0;
try {
  const source = join(directory, "source"),
    project = join(directory, "http");
  await mkdir(source);
  await mkdir(join(project, "SiliconYC"), { recursive: true });
  git(["init", "-b", "main", source]);
  git(["-C", source, "config", "user.name", "Fixture"]);
  git(["-C", source, "config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(source, "main.py"), 'print("fixture")\n');
  await writeFile(
    join(source, "large-fixture.bin"),
    randomBytes(3 * 1024 * 1024),
  );
  git(["-C", source, "add", "."]);
  git(["-C", source, "commit", "-m", "fixture"]);
  const expected = git(["-C", source, "rev-parse", "HEAD"]).toString().trim();
  git(["clone", "--bare", source, join(project, "SiliconYC/poly-tally.git")]);
  mf = new Miniflare(
    convertV4MiniflareOptions({
      host: "127.0.0.1",
      port: 0,
      workers: [
        {
          name: "gateway",
          modules: true,
          modulesRoot: resolve(import.meta.dirname, "../../.."),
          scriptPath: resolve(
            import.meta.dirname,
            "../../../poly-tally-gateway-worker.js",
          ),
          compatibilityDate: "2026-10-24",
          bindings: fake,
          outboundService: async (request) => {
            const url = new URL(request.url);
            if (url.origin === "https://api.github.com")
              return publicationUpstream(request, url);
            assert.equal(url.origin, "https://github.com");
            assert.match(
              url.pathname,
              /^\/SiliconYC\/poly-tally\.git\/(info\/refs|git-upload-pack)$/,
            );
            assert.equal(
              request.headers.get("Authorization"),
              "Basic " + btoa("x-access-token:" + fake.GITHUB_READ_TOKEN),
            );
            upstreamRequests++;
            if (url.pathname.endsWith("git-upload-pack")) uploadPackRequests++;
            const child = spawn("git", ["http-backend"], {
              env: {
                ...env,
                GIT_PROJECT_ROOT: project,
                GIT_HTTP_EXPORT_ALL: "1",
                REQUEST_METHOD: request.method,
                PATH_INFO: url.pathname,
                QUERY_STRING: url.search.slice(1),
                CONTENT_TYPE: request.headers.get("Content-Type") || "",
                HTTP_GIT_PROTOCOL: request.headers.get("Git-Protocol") || "",
                REMOTE_USER: "fixture",
              },
              stdio: ["pipe", "pipe", "pipe"],
            });
            if (request.body) {
              for await (const chunk of request.body) child.stdin.write(chunk);
            }
            child.stdin.end();
            let controller;
            const stream = new ReadableStream({
              start(c) {
                controller = c;
              },
              cancel() {
                child.kill();
              },
            });
            let header = Buffer.alloc(0),
              ready = false;
            return new Promise((resolveResponse, reject) => {
              child.stdout.on("data", (chunk) => {
                if (ready) {
                  controller.enqueue(new Uint8Array(chunk));
                  return;
                }
                header = Buffer.concat([header, chunk]);
                const at = header.indexOf("\r\n\r\n");
                if (at < 0) {
                  if (header.length > 65536)
                    reject(new Error("Fixture CGI headers too large"));
                  return;
                }
                const headers = new Headers();
                let status = 200;
                for (const line of header
                  .subarray(0, at)
                  .toString()
                  .split("\r\n")) {
                  const split = line.indexOf(":");
                  if (split < 0) continue;
                  const key = line.slice(0, split),
                    value = line.slice(split + 1).trim();
                  if (key.toLowerCase() === "status")
                    status = Number(value.split(" ")[0]);
                  else headers.set(key, value);
                }
                ready = true;
                resolveResponse(new Response(stream, { status, headers }));
                if (header.length > at + 4)
                  controller.enqueue(new Uint8Array(header.subarray(at + 4)));
                header = null;
              });
              child.stdout.on("end", () => {
                if (!ready) reject(new Error("Fixture did not respond"));
                else controller.close();
              });
              child.on("error", reject);
              child.stderr.resume();
            });
          },
        },
      ],
    }),
  );
  await mf.ready;
  // Test-only loopback bridge supplies virtual HTTPS to the UNCHANGED production
  // bundle. Production HTTPS enforcement is never disabled by a binding.
  bridge = createServer(async (req, res) => {
    try {
      const response = await mf.dispatchFetch(
        `https://gateway.example${req.url}`,
        {
          method: req.method,
          headers: req.headers,
          ...(req.method === "POST"
            ? { body: Readable.toWeb(req), duplex: "half" }
            : {}),
        },
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(res);
      else res.end();
    } catch {
      res.writeHead(502);
      res.end();
    }
  });
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const base = new URL(`http://127.0.0.1:${bridge.address().port}/`);
  const health = await mf.dispatchFetch("https://gateway.example/health");
  assert.equal(health.status, 200);
  const unauthorized = await mf.dispatchFetch(
    new URL(
      "/git/SiliconYC/poly-tally.git/info/refs?service=git-upload-pack",
      "https://gateway.example",
    ),
  );
  assert.equal(unauthorized.status, 401);
  const cache = join(directory, "cache.git");
  git(["init", "--bare", cache]);
  const transportEnv = {
    ...env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${base.origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${fake.GATEWAY_KEY}`,
  };
  const asyncGit = (args) =>
    new Promise((res, rej) => {
      const child = spawn("git", ["-c", "credential.helper=", ...args], {
        env: transportEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (b) => (out += b));
      child.stderr.resume();
      child.on("error", rej);
      child.on("exit", (code) =>
        code === 0
          ? res(out)
          : rej(new Error(`Isolated fixture Git exited ${code}`)),
      );
    });
  const url = new URL("/git/SiliconYC/poly-tally.git", base).toString();
  await asyncGit([
    "--git-dir",
    cache,
    "fetch",
    "--no-tags",
    "--",
    url,
    "+refs/heads/main:refs/poly-tally/default",
  ]);
  assert.equal(
    git(["--git-dir", cache, "rev-parse", "refs/poly-tally/default"])
      .toString()
      .trim(),
    expected,
  );
  const firstPacks = uploadPackRequests;
  await asyncGit([
    "--git-dir",
    cache,
    "fetch",
    "--no-tags",
    "--",
    url,
    "+refs/heads/main:refs/poly-tally/default",
  ]);
  assert.equal(
    uploadPackRequests - firstPacks,
    1,
    "warm Git performs protocol v2 ls-refs but no fetch pack round",
  );
  await writeFile(join(source, "main.py"), 'print("fixture increment")\n');
  git(["-C", source, "add", "."]);
  git(["-C", source, "commit", "-m", "increment"]);
  git([
    "-C",
    source,
    "push",
    join(project, "SiliconYC/poly-tally.git"),
    "main",
  ]);
  await asyncGit([
    "--git-dir",
    cache,
    "fetch",
    "--no-tags",
    "--",
    url,
    "+refs/heads/main:refs/poly-tally/default",
  ]);
  assert.equal(
    git(["--git-dir", cache, "rev-list", "--count", "refs/poly-tally/default"])
      .toString()
      .trim(),
    "2",
  );
  const privateData = structuredClone(
      bootstrap.baselines.find((b) => b.path === "private-metrics.json").data,
    ),
    generatedAt = "2026-10-24T13:00:00Z";
  privateData.generatedAt = generatedAt;
  for (const repository of privateData.repositories) {
    repository.lastSuccessAt = generatedAt;
    if (repository.status === "active") {
      const point = repository.history.at(-1);
      repository.history = Array.from({ length: 80 }, (_, i) => ({
        ...structuredClone(point),
        timestamp: `${new Date(Date.UTC(2026, 7, i + 1)).toISOString().slice(0, 10)}T23:59:59.999999Z`,
      }));
    }
  }
  const metrics = { code: 1, comment: 0, blank: 0, documentation: 0, files: 1 },
    proof = (n) => ({
      complete: true,
      discoveryComplete: true,
      expectedRepositories: n,
      scannedRepositories: n,
      missingMembers: 0,
      failed: 0,
    });
  const repositories = Array.from({ length: 11 }, (_, i) => ({
    id: String(900000000 + i),
    name: `SiliconYC/gateway-fixture-${i}`,
    url: `https://github.com/SiliconYC/gateway-fixture-${i}`,
    branch: "main",
    status: "active",
    lastSuccessAt: generatedAt,
    rulesVersion: policy.rulesVersion,
    historyComplete: true,
    notice: "",
    skippedFiles: 0,
    lastCommitDate: "2026-10-23",
    history: [
      {
        timestamp: "2026-10-23T00:00:00Z",
        metrics,
        languages: { Python: metrics },
      },
    ],
  }));
  const publicData = {
    schemaVersion: 1,
    generatedAt,
    datasetEpoch: policy.datasetEpoch,
    rules: {
      version: policy.rulesVersion,
      description:
        "按当前默认分支第一父链与统一规则重建；代码存量，不代表个人贡献。混合行归代码；文档独立。",
    },
    collector: { version: policy.collectorVersion },
    lineageVersion: policy.lineageVersion,
    completeness: proof(11),
    summary: {
      code: 11,
      comment: 0,
      blank: 0,
      documentation: 0,
      files: 11,
      repositories: 11,
      publicRepositories: 11,
      privateRepositories: 0,
      commits: 11,
      snapshots: 11,
    },
    repositories,
  };
  await publishGateway({
    publicData,
    privateData,
    policy,
    env: {
      POLY_TALLY_GATEWAY_URL: "https://gateway.example",
      POLY_TALLY_GATEWAY_PASSWORD: fake.GATEWAY_KEY,
    },
    fetcher: (url, options) => mf.dispatchFetch(url, options),
  });
  assert.equal(dispatched, 1);
  const restart = await mf.dispatchFetch(
    "https://gateway.example/publish/start",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${fake.GATEWAY_KEY}` },
      body: "{}",
    },
  );
  assert.equal(
    restart.status,
    200,
    "signed compact baseline survives actual workerd write roundtrip",
  );
  const size = Number(
    git([
      "--git-dir",
      cache,
      "cat-file",
      "-s",
      `${expected}:large-fixture.bin`,
    ]).toString(),
  );
  assert.equal(size, 3 * 1024 * 1024);
  console.log(
    JSON.stringify({
      runtime: "local workerd",
      nativeGit: true,
      fixtureBytes: size,
      coldAndWarm: true,
      incremental: true,
      publicationRoundtrip: true,
      publicationRequests,
      sanitizedFixtureBytes: Buffer.byteLength(JSON.stringify(privateData)),
      upstreamRequests,
      uploadPackRequests,
      credentials: "fake only",
      productionCPU: "NOT VERIFIED",
    }),
  );
} finally {
  if (bridge) await new Promise((resolve) => bridge.close(resolve));
  if (mf) await mf.dispose();
  await rm(directory, { recursive: true, force: true });
}
