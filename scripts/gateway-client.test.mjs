import test from "node:test";
import assert from "node:assert/strict";
import { gatewayConfig } from "./gateway-client.mjs";
const env = {
  POLY_TALLY_GATEWAY_URL: "https://gateway.example",
  POLY_TALLY_GATEWAY_PASSWORD:
    "fixture-password-only-not-a-real-secret-123456789",
};
test("gateway entry is explicit and fails before any legacy helper/token fallback", () => {
  assert.throws(() => gatewayConfig({}, true), /gateway/i);
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "POLY_TALLY_TOKEN"])
    assert.throws(
      () => gatewayConfig({ ...env, [key]: "fake" }, true),
      /token/i,
    );
  for (const url of [
    "http://gateway.example",
    "https://x:y@gateway.example",
    "https://gateway.example/path",
    "https://gateway.example?x=secret",
  ])
    assert.throws(() =>
      gatewayConfig({ ...env, POLY_TALLY_GATEWAY_URL: url }, true),
    );
  assert.deepEqual(gatewayConfig(env, true), {
    origin: env.POLY_TALLY_GATEWAY_URL,
    password: env.POLY_TALLY_GATEWAY_PASSWORD,
  });
});

test("explicit proxy-password file requires owner-only file and parent permissions", async (t) => {
  const { mkdtemp, mkdir, writeFile, chmod, rm } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "gateway-password-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await chmod(dir, 0o700);
  const file = join(dir, "proxy-password");
  await writeFile(file, env.POLY_TALLY_GATEWAY_PASSWORD + "\n", {
    mode: 0o600,
  });
  const configured = {
    POLY_TALLY_GATEWAY_URL: env.POLY_TALLY_GATEWAY_URL,
    POLY_TALLY_GATEWAY_PASSWORD_FILE: file,
  };
  assert.equal(
    gatewayConfig(configured, true).password,
    env.POLY_TALLY_GATEWAY_PASSWORD,
  );
  assert.throws(() =>
    gatewayConfig(
      { ...configured, POLY_TALLY_GATEWAY_PASSWORD: "ambiguous" },
      true,
    ),
  );
  await chmod(file, 0o644);
  assert.throws(() => gatewayConfig(configured, true));
  await chmod(file, 0o600);
  await chmod(dir, 0o755);
  assert.throws(() => gatewayConfig(configured, true));
});
test("a GitHub-looking token cannot accidentally become the gateway password", () => {
  for (const prefix of ["ghp_", "github_pat_", "gho_"])
    assert.throws(() =>
      gatewayConfig(
        {
          ...env,
          POLY_TALLY_GATEWAY_PASSWORD: prefix + "FAKE_NOT_REAL_".repeat(5),
        },
        true,
      ),
    );
});
