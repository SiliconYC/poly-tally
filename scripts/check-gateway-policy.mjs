import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSnapshotPolicy } from "./publish-snapshot.mjs";
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
  return { configSha256: checked.configSha256 };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await checkGatewayPolicy();
    console.log(
      "Worker policy hash verified; runtime baseline is fetched and validated by Worker, never embedded.",
    );
  } catch {
    console.error(
      "Gateway build blocked: publication policy/configuration mismatch.",
    );
    process.exitCode = 1;
  }
}
