import {
  newValidation,
  validateChunk,
  sealValidation,
} from "../src/validation.mjs";
import { snapshotChunks } from "../../../scripts/gateway-protocol.mjs";
export const policy = {
  configSha256: "c".repeat(64),
  datasetEpoch: "test-v1",
  rulesVersion: "0123456789abcdef",
  lineageVersion: "fedcba9876543210",
  collectorVersion: "poly-tally/4;pygments/2.21.0",
  lineageGroups: [],
};
const generatedAt = "2026-10-24T01:00:00Z";
const metrics = { code: 5, comment: 0, blank: 1, documentation: 0, files: 1 };
const proof = (n) => ({
  complete: true,
  discoveryComplete: true,
  expectedRepositories: n,
  scannedRepositories: n,
  missingMembers: 0,
  failed: 0,
});
export function fixtures(snapshotPolicy = policy) {
  const policy = snapshotPolicy;
  const pub = {
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
    completeness: proof(1),
    summary: {
      ...metrics,
      repositories: 1,
      publicRepositories: 1,
      privateRepositories: 0,
      commits: 1,
      snapshots: 1,
    },
    repositories: [
      {
        id: "1",
        name: "SiliconYC/public",
        url: "https://github.com/SiliconYC/public",
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
      },
    ],
  };
  const key = "0123456789abcdef",
    priv = {
      schemaVersion: 1,
      generatedAt,
      datasetEpoch: policy.datasetEpoch,
      rulesVersion: policy.rulesVersion,
      lineageVersion: policy.lineageVersion,
      completeness: proof(2),
      source: "local",
      collection: { repositories: 1, failed: 0 },
      archivedRepositoryKeys: [],
      repositories: [
        {
          id: `private-${key}`,
          name: "SiliconYC/private",
          sourceKey: key,
          visibility: "private",
          snapshotKind: "daily",
          url: null,
          branch: null,
          head: null,
          status: "active",
          lastSuccessAt: generatedAt,
          rulesVersion: policy.rulesVersion,
          historyComplete: true,
          notice: "私有仓库：仅公开按日规模，不公开源码与提交详情。",
          skippedFiles: 0,
          lastCommitDate: "2026-10-23",
          history: [
            {
              timestamp: "2026-10-23T23:59:59.999999Z",
              metrics,
              languages: { Python: metrics },
            },
          ],
        },
      ],
    };
  return { pub, priv };
}
export function validatePair(pub, priv) {
  let state = newValidation();
  for (const [kind, data] of [
    ["public", pub],
    ["private", priv],
  ])
    for (const chunk of snapshotChunks(data, kind))
      state = validateChunk(state, chunk, policy);
  return sealValidation(state, policy, []);
}
