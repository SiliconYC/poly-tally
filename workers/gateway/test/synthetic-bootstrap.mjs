// Entirely invented repositories, IDs, values and hashes; no production dataset.
import { fixtures } from "./fixtures.mjs";
import { policy } from "../src/policy.mjs";
import { createHash } from "node:crypto";
export { policy };
const { priv } = fixtures(policy);
const row = priv.repositories[0];
priv.repositories = Array.from({ length: 21 }, (_, i) => {
  const sourceKey = (i + 1).toString(16).padStart(16, "0");
  return {
    ...structuredClone(row),
    id: `private-${sourceKey}`,
    sourceKey,
    name: `SiliconYC/private-fixture-${i}`,
  };
});
for (let i = 0; i < policy.lineageGroups.length; i++) {
  const group = policy.lineageGroups[i],
    key = createHash("sha256")
      .update(`poly-tally/repository/lineage:${group.id}`)
      .digest("hex")
      .slice(0, 16);
  const members = group.members.map((name, j) => ({
    name,
    sourceKey: createHash("sha256")
      .update(`synthetic-member-${i}-${j}`)
      .digest("hex")
      .slice(0, 16),
  }));
  Object.assign(priv.repositories[i], {
    id: `private-${key}`,
    sourceKey: key,
    name: group.members[0],
    lineage: {
      id: group.id,
      version: policy.lineageVersion,
      members,
      dominantMember: group.members[0],
      representativeMember: group.members[0],
    },
  });
}
priv.collection.repositories = priv.repositories.length;
priv.completeness.expectedRepositories = priv.completeness.scannedRepositories =
  11 +
  priv.repositories.reduce((n, r) => n + (r.lineage?.members.length ?? 1), 0);
const rebuilt = structuredClone(priv);
rebuilt.completeness.complete = false;
rebuilt.completeness.discoveryComplete = false;
const baseline = (path, data) => {
  const bytes = JSON.stringify(data);
  return {
    path,
    data,
    sha: createHash("sha1")
      .update(`blob ${Buffer.byteLength(bytes)}\0`)
      .update(bytes)
      .digest("hex"),
  };
};
export const bootstrap = {
  schemaVersion: 1,
  policy: policy.configSha256,
  sourceCommit: "1".repeat(40),
  baselines: [
    baseline("private-metrics.json", priv),
    baseline("rebuilt-private-metrics.json", rebuilt),
  ],
};
