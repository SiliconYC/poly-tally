import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSnapshotPolicy } from "./publish-snapshot.mjs";
import {
  validateCompletePrivateMetrics,
  validateRebuiltPrivateMetrics,
} from "./metrics.mjs";
import { policy } from "../workers/gateway/src/policy.mjs";
export async function checkGatewayPolicy({
  root = resolve(import.meta.dirname, ".."),
} = {}) {
  const checked = await loadSnapshotPolicy(root);
  assert.deepEqual(
    policy,
    checked,
    "Worker policy must match the original configuration hash gate",
  );
  const bootstrap = JSON.parse(
    await readFile(
      resolve(root, "workers/gateway/.local/bootstrap-baseline.json"),
      "utf8",
    ),
  );
  assert.equal(bootstrap.schemaVersion, 1);
  assert.equal(bootstrap.policy, checked.configSha256);
  assert.match(bootstrap.sourceCommit, /^[a-f0-9]{40}$/);
  for (const entry of bootstrap.baselines) {
    assert.match(entry.sha, /^[a-f0-9]{40}$/);
    assert.ok(
      ["private-metrics.json", "rebuilt-private-metrics.json"].includes(
        entry.path,
      ),
    );
    if (entry.path === "private-metrics.json")
      validateCompletePrivateMetrics(entry.data);
    else validateRebuiltPrivateMetrics(entry.data);
  }
  return {
    sourceCommit: bootstrap.sourceCommit,
    baselineCount: bootstrap.baselines.length,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await checkGatewayPolicy();
    console.log(
      "Worker policy hash and deployment-local bootstrap schema verified.",
    );
  } catch {
    console.error(
      "Gateway build blocked: prepare and review the ignored local bootstrap; missing/invalid baseline or policy mismatch.",
    );
    process.exitCode = 1;
  }
}
