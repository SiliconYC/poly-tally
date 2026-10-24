// Shared canonical serialization. Only schema-approved objects reach this code
// on the Worker. Never sign caller raw JSON (duplicate keys can hide text).
export const MAX_UPLOAD_BYTES = 1024 * 1024;
export const MAX_CHUNK_BYTES = 16 * 1024;
export const MAX_REPOSITORIES = 64;
export const omitHistory = (repository) =>
  Object.fromEntries(
    Object.entries(repository).filter(([key]) => key !== "history"),
  );
export const artifactHeader = (data) =>
  Object.fromEntries(
    Object.entries(data).filter(([key]) => key !== "repositories"),
  );
export const startArtifact = (header) =>
  JSON.stringify(header).slice(0, -1) + ',"repositories":[';
export const startRepository = (repository, index) =>
  `${index ? "," : ""}${JSON.stringify(repository).slice(0, -1)},"history":[`;
export const historyFragment = (history, offset) =>
  `${offset ? "," : ""}${history.map((point) => JSON.stringify(point)).join(",")}`;
export const escapeContent = (fragment) =>
  JSON.stringify(fragment).slice(1, -1);
export function canonicalSnapshot(data) {
  return (
    startArtifact(artifactHeader(data)) +
    data.repositories
      .map(
        (repository, index) =>
          startRepository(omitHistory(repository), index) +
          historyFragment(repository.history, 0) +
          "]}",
      )
      .join("") +
    "]}"
  );
}
export function blobBody(data) {
  return JSON.stringify({
    content: canonicalSnapshot(data),
    encoding: "utf-8",
  });
}
export function* snapshotChunks(data, kind) {
  yield { action: "artifact", kind, header: artifactHeader(data) };
  for (const repository of data.repositories) {
    yield { action: "repository", repository: omitHistory(repository) };
    let batch = [];
    for (const point of repository.history) {
      const candidate = [...batch, point];
      if (
        candidate.length > 8 ||
        new TextEncoder().encode(
          JSON.stringify({ action: "history", history: candidate }),
        ).length > MAX_CHUNK_BYTES
      ) {
        if (!batch.length)
          throw new Error("Snapshot point exceeds gateway chunk limit");
        yield { action: "history", history: batch };
        batch = [point];
      } else batch = candidate;
    }
    if (batch.length) yield { action: "history", history: batch };
    yield { action: "end-repository" };
  }
  yield { action: "end-artifact" };
}
