// Explicit build-time migration from PUBLIC, already-sanitized durable state.
// Deployment-local data only: never commit or include this output in a source PR.
// No token, credential helper, private source endpoint, or owner secret is used.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { loadSnapshotPolicy } from "./publish-snapshot.mjs";
import {
  validateCompletePrivateMetrics,
  validateRebuiltPrivateMetrics,
} from "./metrics.mjs";
const ROOT = "https://api.github.com/repos/SiliconYC/poly-tally";
const compact = (data) => ({
  ...data,
  repositories: data.repositories.map((r) => ({
    ...r,
    history: r.history.slice(-1),
  })),
});
export async function prepareBootstrap({
  root = resolve(import.meta.dirname, ".."),
  fetcher = fetch,
} = {}) {
  const policy = await loadSnapshotPolicy(root);
  const api = async (path) => {
    const res = await fetcher(ROOT + path, {
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "poly-tally-gateway-bootstrap/1",
      },
    });
    if (!res.ok)
      throw new Error(
        `Public sanitized baseline read failed: HTTP ${res.status}`,
      );
    return res.json();
  };
  const ref = await api("/git/ref/heads/tally-state"),
    commit = await api(`/git/commits/${ref.object.sha}`),
    tree = await api(`/git/trees/${commit.tree.sha}`);
  if (tree.truncated || !Array.isArray(tree.tree))
    throw new Error("Incomplete durable tree");
  const entries = tree.tree.filter((e) =>
    ["private-metrics.json", "rebuilt-private-metrics.json"].includes(e.path),
  );
  const baselines = [];
  for (const entry of entries) {
    if (
      entry.type !== "blob" ||
      entry.mode !== "100644" ||
      !/^[a-f0-9]{40}$/.test(entry.sha) ||
      entry.size > 1048576
    )
      throw new Error("Unsupported sanitized baseline");
    const blob = await api(`/git/blobs/${entry.sha}`),
      bytes = Buffer.from(blob.content, "base64");
    if (
      blob.sha !== entry.sha ||
      createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex") !== entry.sha
    )
      throw new Error("Baseline Git blob SHA mismatch");
    const data = JSON.parse(bytes);
    if (entry.path === "private-metrics.json")
      validateCompletePrivateMetrics(data);
    else validateRebuiltPrivateMetrics(data);
    baselines.push({ path: entry.path, sha: entry.sha, data: compact(data) });
  }
  const output = {
    schemaVersion: 1,
    policy: policy.configSha256,
    sourceCommit: ref.object.sha,
    baselines,
  };
  const file = resolve(root, "workers/gateway/.local/bootstrap-baseline.json");
  await mkdir(resolve(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify(output));
  return {
    sourceCommit: ref.object.sha,
    baselineCount: baselines.length,
    bytes: Buffer.byteLength(JSON.stringify(output)),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(JSON.stringify(await prepareBootstrap()));
  } catch {
    console.error(
      "Public sanitized baseline preparation failed; no token/helper fallback is supported",
    );
    process.exitCode = 1;
  }
}
