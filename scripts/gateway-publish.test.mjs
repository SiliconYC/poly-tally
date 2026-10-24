import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  rm,
  chmod,
  stat,
  symlink,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { retryGatewayDispatch } from "./gateway-publish.mjs";

test("malformed snapshot JSON cannot be reflected into CLI output", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-invalid-input-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pub = join(dir, "public.json"),
    priv = join(dir, "private.json");
  await writeFile(pub, '{"SECRET_SENTINEL_MUST_NOT_LOG": invalid syntax}');
  await writeFile(priv, "{}");
  const r = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, "gateway-publish.mjs"), pub, priv],
    {
      encoding: "utf8",
      env: {
        HOME: dir,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout + r.stderr, /SECRET_SENTINEL/);
});
test("saved dispatch receipt retries the same selected snapshot without collection or new commit", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-retry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "receipt.json");
  await writeFile(
    file,
    JSON.stringify({ receipt: "fixture-signed-capability" }),
    { mode: 0o600 },
  );
  let calls = 0;
  const result = await retryGatewayDispatch(file, {
    env: {
      POLY_TALLY_GATEWAY_URL: "https://gateway.example",
      POLY_TALLY_GATEWAY_PASSWORD:
        "fixture-proxy-password-not-a-real-secret-123456789",
    },
    fetcher: async (url, options) => {
      calls++;
      assert.equal(url, "https://gateway.example/publish/dispatch");
      assert.deepEqual(JSON.parse(options.body), {
        receipt: "fixture-signed-capability",
      });
      return Response.json({ dispatched: true });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.dispatched, true);
});

test("pending commit retry first confirms exact prior commit via readonly status, never repeats commit", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-pending-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "receipt.json"),
    pending = {
      public: "fake-public-capability",
      private: "fake-private-capability",
      selection: "fake-selection-capability",
    };
  await writeFile(file, JSON.stringify({ pending }), { mode: 0o600 });
  const calls = [];
  await retryGatewayDispatch(file, {
    env: {
      POLY_TALLY_GATEWAY_URL: "https://gateway.example",
      POLY_TALLY_GATEWAY_PASSWORD:
        "fixture-proxy-password-not-a-real-secret-123456789",
    },
    fetcher: async (url, options) => {
      calls.push(new URL(url).pathname);
      if (url.endsWith("/status")) {
        assert.deepEqual(JSON.parse(options.body), pending);
        return Response.json({
          receipt: "fake-recovered-dispatch",
          snapshotCommit: "a".repeat(40),
        });
      }
      assert.equal(url, "https://gateway.example/publish/dispatch");
      return Response.json({ dispatched: true });
    },
  });
  assert.deepEqual(calls, ["/publish/status", "/publish/dispatch"]);
});

const fakeGatewayEnv = {
  POLY_TALLY_GATEWAY_URL: "https://gateway.example",
  POLY_TALLY_GATEWAY_PASSWORD:
    "fixture-proxy-password-not-a-real-secret-123456789",
};
test("existing dispatch receipt permissions are tightened to 0600 before use", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-permissions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "receipt.json");
  await writeFile(
    file,
    JSON.stringify({
      pending: {
        public: "fake-public",
        private: "fake-private",
        selection: "fake-selection",
      },
    }),
  );
  await chmod(file, 0o644);
  await retryGatewayDispatch(file, {
    env: fakeGatewayEnv,
    fetcher: async (url) => {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      return Response.json(
        url.endsWith("/status")
          ? { receipt: "fake-confirmed" }
          : { dispatched: true },
      );
    },
  });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
test("dispatch receipt symlink is rejected without reading or changing its target", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-symlink-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, "unrelated.json"),
    file = join(dir, "receipt.json"),
    original = JSON.stringify({ receipt: "fake-unrelated-sentinel" });
  await writeFile(target, original, { mode: 0o644 });
  await symlink(target, file);
  let calls = 0;
  await assert.rejects(
    () =>
      retryGatewayDispatch(file, {
        env: fakeGatewayEnv,
        fetcher: async () => {
          calls++;
          return Response.json({});
        },
      }),
    /Gateway receipt file is unsafe or unavailable/,
  );
  assert.equal(calls, 0);
  assert.equal(await readFile(target, "utf8"), original);
  assert.equal((await stat(target)).mode & 0o777, 0o644);
});
