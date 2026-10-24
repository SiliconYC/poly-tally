import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  copyFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { prepareBootstrap } from "./prepare-gateway-bootstrap.mjs";
import { checkGatewayPolicy } from "./check-gateway-policy.mjs";
import { fixtures } from "../workers/gateway/test/fixtures.mjs";

test("bootstrap generator writes synthetic data only to ignored deployment-local path", async () => {
  const root = await mkdtemp(join(tmpdir(), "poly-bootstrap-test-"));
  try {
    await mkdir(resolve(root, "scripts"));
    for (const path of ["config.json", "scripts/snapshot-policy.json"])
      await copyFile(
        new URL(`../${path}`, import.meta.url),
        resolve(root, path),
      );
    await assert.rejects(checkGatewayPolicy({ root }), { code: "ENOENT" });
    const bytes = Buffer.from(JSON.stringify(fixtures().priv));
    const sha = createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    const sourceCommit = "1".repeat(40),
      tree = "2".repeat(40);
    const fetcher = async (url, options) => {
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, undefined);
      const path = url.replace(
        "https://api.github.com/repos/SiliconYC/poly-tally",
        "",
      );
      if (path === "/git/ref/heads/tally-state")
        return Response.json({ object: { sha: sourceCommit } });
      if (path === `/git/commits/${sourceCommit}`)
        return Response.json({ tree: { sha: tree } });
      if (path === `/git/trees/${tree}`)
        return Response.json({
          tree: [
            {
              path: "private-metrics.json",
              mode: "100644",
              type: "blob",
              sha,
              size: bytes.length,
            },
          ],
          truncated: false,
        });
      assert.equal(path, `/git/blobs/${sha}`);
      return Response.json({ sha, content: bytes.toString("base64") });
    };
    await prepareBootstrap({ root, fetcher });
    const local = JSON.parse(
      await readFile(
        resolve(root, "workers/gateway/.local/bootstrap-baseline.json"),
        "utf8",
      ),
    );
    assert.equal(local.sourceCommit, sourceCommit);
    assert.equal(local.baselines[0].sha, sha);
    assert.equal(
      local.baselines[0].data.repositories[0].name,
      "SiliconYC/private",
    );
    assert.deepEqual(await checkGatewayPolicy({ root }), {
      sourceCommit,
      baselineCount: 1,
    });
    await assert.rejects(
      access(resolve(root, "workers/gateway/bootstrap-baseline.json")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
