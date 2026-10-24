import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
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
