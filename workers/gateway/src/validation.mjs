import {
  validateCompletePrivateMetrics,
  validatePrivateMetricsReplacement,
} from "../../../scripts/metrics.mjs";
import {
  validatePublicSnapshot,
  validateSnapshotPair,
} from "../../../scripts/publish-snapshot.mjs";
import {
  MAX_UPLOAD_BYTES,
  MAX_CHUNK_BYTES,
  MAX_REPOSITORIES,
  startArtifact,
  startRepository,
  historyFragment,
  escapeContent,
} from "../../../scripts/gateway-protocol.mjs";
import { newHash, updateHash, finishHash } from "./hash-state.mjs";
const encoder = new TextEncoder(),
  metrics = ["code", "comment", "blank", "documentation", "files"];
const fail = () => {
  throw new Error("Invalid bounded snapshot protocol");
};
const exact = (value, keys) => {
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((k) => Object.hasOwn(value, k))
  )
    fail();
};
export function summary(repositories, count) {
  const active = repositories.filter((r) => r.status === "active");
  return {
    ...Object.fromEntries(
      metrics.map((k) => [
        k,
        active.reduce((n, r) => n + (r.history.at(-1)?.metrics[k] ?? 0), 0),
      ]),
    ),
    repositories: active.length,
    publicRepositories: active.length,
    privateRepositories: 0,
    commits: count ?? active.reduce((n, r) => n + r.history.length, 0),
    snapshots: count ?? active.reduce((n, r) => n + r.history.length, 0),
  };
}
export const compact = (data) => ({
  ...data,
  repositories: data.repositories.map((r) => ({
    ...r,
    history: r.history.slice(-1),
  })),
});
function validateOne(kind, header, repository, history, policy) {
  const row = { ...repository, history };
  if (kind === "public")
    validatePublicSnapshot(
      { ...header, summary: summary([row]), repositories: [row] },
      policy,
    );
  else
    validateCompletePrivateMetrics({
      ...header,
      collection: { repositories: 1, failed: 0 },
      repositories: [row],
    });
}
function append(artifact, fragment) {
  artifact.hashState = updateHash(
    artifact.hashState,
    encoder.encode(escapeContent(fragment)),
  );
  if (artifact.hashState.length > MAX_UPLOAD_BYTES - 32) fail();
}
export const newValidation = () => ({
  phase: "public",
  public: null,
  private: null,
  pending: null,
});
export function validateChunk(state, chunk, policy) {
  if (encoder.encode(JSON.stringify(chunk)).length > MAX_CHUNK_BYTES) fail();
  const kind = state.phase;
  if (!["public", "private"].includes(kind)) fail();
  if (chunk.action === "artifact") {
    exact(chunk, ["action", "kind", "header"]);
    if (
      state[kind] ||
      chunk.kind !== kind ||
      Object.hasOwn(chunk.header, "repositories")
    )
      fail();
    const header = chunk.header;
    if (kind === "public")
      validatePublicSnapshot(
        { ...header, summary: summary([]), repositories: [] },
        policy,
      );
    else {
      exact(header.collection, ["repositories", "failed"]);
      validateCompletePrivateMetrics({
        ...header,
        collection: { repositories: 0, failed: 0 },
        repositories: [],
      });
      if (
        header.schemaVersion !== 1 ||
        header.datasetEpoch !== policy.datasetEpoch ||
        header.rulesVersion !== policy.rulesVersion ||
        header.lineageVersion !== policy.lineageVersion ||
        header.completeness?.complete !== true ||
        header.completeness.discoveryComplete !== true ||
        header.completeness.expectedRepositories !==
          header.completeness.scannedRepositories ||
        header.completeness.failed !== 0 ||
        header.completeness.missingMembers !== 0 ||
        header.collection?.failed !== 0 ||
        !Number.isSafeInteger(header.collection?.repositories) ||
        header.collection.repositories < 1
      )
        fail();
    }
    const artifact = {
      header,
      repositories: [],
      count: 0,
      hashState: updateHash(newHash(), encoder.encode('{"content":"')),
    };
    append(artifact, startArtifact(header));
    state[kind] = artifact;
    return state;
  }
  const artifact = state[kind];
  if (!artifact) fail();
  if (chunk.action === "repository") {
    exact(chunk, ["action", "repository"]);
    if (
      state.pending ||
      artifact.repositories.length >= MAX_REPOSITORIES ||
      Object.hasOwn(chunk.repository, "history")
    )
      fail();
    const repository = chunk.repository;
    const zero = Object.fromEntries(metrics.map((k) => [k, 0]));
    validateOne(
      kind,
      artifact.header,
      repository,
      repository.status === "active"
        ? [
            {
              timestamp: artifact.header.generatedAt,
              metrics: zero,
              languages: {},
            },
          ]
        : [],
      policy,
    );
    append(artifact, startRepository(repository, artifact.repositories.length));
    state.pending = { repository, count: 0, last: null };
  } else if (chunk.action === "history") {
    exact(chunk, ["action", "history"]);
    const pending = state.pending;
    if (
      !pending ||
      !Array.isArray(chunk.history) ||
      chunk.history.length < 1 ||
      chunk.history.length > 8 ||
      pending.repository.status !== "active"
    )
      fail();
    validateOne(
      kind,
      artifact.header,
      pending.repository,
      chunk.history,
      policy,
    );
    if (
      pending.last &&
      (kind === "private"
        ? pending.last.timestamp.slice(0, 10) >=
          chunk.history[0].timestamp.slice(0, 10)
        : Date.parse(pending.last.timestamp) >
          Date.parse(chunk.history[0].timestamp))
    )
      fail();
    append(artifact, historyFragment(chunk.history, pending.count));
    pending.count += chunk.history.length;
    pending.last = chunk.history.at(-1);
  } else if (chunk.action === "end-repository") {
    exact(chunk, ["action"]);
    const pending = state.pending;
    if (
      !pending ||
      (pending.repository.status === "active" && pending.count === 0) ||
      (pending.repository.status === "empty" && pending.count !== 0)
    )
      fail();
    append(artifact, "]}");
    artifact.repositories.push({
      ...pending.repository,
      history: pending.last ? [pending.last] : [],
    });
    artifact.count += pending.count;
    state.pending = null;
  } else if (chunk.action === "end-artifact") {
    exact(chunk, ["action"]);
    if (state.pending) fail();
    if (kind === "public") {
      const expected = summary(artifact.repositories, artifact.count);
      exact(artifact.header.summary, Object.keys(expected));
      if (
        !Object.entries(expected).every(
          ([k, v]) =>
            Number.isSafeInteger(v) && artifact.header.summary[k] === v,
        )
      )
        fail();
    } else if (
      artifact.header.collection.repositories !== artifact.repositories.length
    )
      fail();
    append(artifact, "]}");
    artifact.hashState = updateHash(
      artifact.hashState,
      encoder.encode('","encoding":"utf-8"}'),
    );
    if (artifact.hashState.length > MAX_UPLOAD_BYTES) fail();
    state.phase = kind === "public" ? "private" : "complete";
  } else fail();
  return state;
}
export function sealValidation(state, policy, baselines) {
  if (state.phase !== "complete" || state.pending) fail();
  const pub = {
    ...state.public.header,
    summary: summary(state.public.repositories),
    repositories: state.public.repositories,
  };
  const priv = {
    ...state.private.header,
    repositories: state.private.repositories,
  };
  validateSnapshotPair(pub, priv, policy);
  for (const baseline of baselines)
    validatePrivateMetricsReplacement(baseline, priv, pub, {
      resetEpoch: policy.datasetEpoch,
      preserveScope: true,
    });
  return Object.fromEntries(
    ["public", "private"].map((kind) => [
      kind,
      {
        hash: finishHash(state[kind].hashState),
        length: state[kind].hashState.length,
      },
    ]),
  );
}
