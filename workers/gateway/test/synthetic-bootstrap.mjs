// Entirely invented repositories, IDs, values and hashes; no production dataset.
import { fixtures, policy } from "./fixtures.mjs";
export { policy };
const { priv } = fixtures();
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
priv.collection.repositories = 21;
priv.completeness.expectedRepositories = 32;
priv.completeness.scannedRepositories = 32;
export const bootstrap = {
  schemaVersion: 1,
  policy: policy.configSha256,
  sourceCommit: "1".repeat(40),
  baselines: [
    { path: "private-metrics.json", sha: "a".repeat(40), data: priv },
  ],
};
