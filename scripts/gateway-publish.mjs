import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadSnapshotPolicy,
  projectPublicStats,
  validateSnapshotPair,
} from "./publish-snapshot.mjs";
import { gatewayClient, GatewayClientError } from "./gateway-client.mjs";
import {
  MAX_UPLOAD_BYTES,
  blobBody,
  snapshotChunks,
} from "./gateway-protocol.mjs";

export async function publishGateway({
  publicData,
  privateData,
  policy,
  env = process.env,
  fetcher = fetch,
  onCommitted,
} = {}) {
  try {
    validateSnapshotPair(publicData, privateData, policy);
  } catch {
    throw new GatewayClientError("Sanitized snapshot validation failed");
  }
  const bodies = {
    public: blobBody(publicData),
    private: blobBody(privateData),
  };
  for (const body of Object.values(bodies))
    if (Buffer.byteLength(body) > MAX_UPLOAD_BYTES)
      throw new GatewayClientError(
        "Sanitized snapshot exceeds the 1 MiB gateway upload ceiling; publication stopped, no large-body fallback",
      );
  const api = gatewayClient({ env, fetcher });
  let result = await api("start", {}),
    receipt = result.receipt;
  while (result.baselineCount) {
    result = await api("baseline", { receipt });
    receipt = result.receipt;
  }
  for (const [kind, data] of [
    ["public", publicData],
    ["private", privateData],
  ])
    for (const chunk of snapshotChunks(data, kind)) {
      result = await api("chunk", { receipt, chunk });
      receipt = result.receipt;
    }
  const sealed = await api("seal", { receipt }),
    uploaded = {};
  for (const kind of ["public", "private"])
    uploaded[kind] = (await api("upload", bodies[kind], sealed[kind])).receipt;
  const committed = await api("commit", {
    ...uploaded,
    selection: sealed.selection,
  });
  if (onCommitted) await onCommitted(committed);
  // If dispatch fails, preserve the saved immutable selectors for authorized retry;
  // never restart collection just to dispatch the exact same snapshot again.
  try {
    await api("dispatch", { receipt: committed.receipt });
  } catch (error) {
    error.publication = {
      snapshotCommit: committed.snapshotCommit,
      publicBlobSha: committed.publicBlobSha,
      privateBlobSha: committed.privateBlobSha,
    };
    throw error;
  }
  return {
    snapshotCommit: committed.snapshotCommit,
    publicBlobSha: committed.publicBlobSha,
    privateBlobSha: committed.privateBlobSha,
  };
}
export async function publishGatewayFiles({
  publicFilename,
  privateFilename,
  root,
  env = process.env,
  fetcher = fetch,
  receiptFilename = resolve(
    dirname(privateFilename),
    "gateway-dispatch-receipt.json",
  ),
} = {}) {
  const policy = await loadSnapshotPolicy(root),
    publicRaw = JSON.parse(await readFile(publicFilename, "utf8")),
    privateData = JSON.parse(await readFile(privateFilename, "utf8"));
  // Always project the ORIGINAL exporter output locally before anything is sent.
  return publishGateway({
    publicData: projectPublicStats(publicRaw, policy),
    privateData,
    policy,
    env,
    fetcher,
    onCommitted: async (committed) => {
      await writeFile(receiptFilename, JSON.stringify(committed), {
        mode: 0o600,
      });
    },
  });
}
export async function retryGatewayDispatch(
  filename,
  { env = process.env, fetcher = fetch } = {},
) {
  const saved = JSON.parse(await readFile(filename, "utf8"));
  return gatewayClient({ env, fetcher })("dispatch", {
    receipt: saved.receipt,
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [publicFilename, privateFilename, ...extra] = process.argv.slice(2);
    if (publicFilename === "retry" && privateFilename && !extra.length) {
      console.log(JSON.stringify(await retryGatewayDispatch(privateFilename)));
    } else {
      if (!publicFilename || !privateFilename || extra.length)
        throw new GatewayClientError(
          "Usage: gateway-publish.mjs original-public-export.json sanitized-private-metrics.json",
        );
      console.log(
        JSON.stringify(
          await publishGatewayFiles({ publicFilename, privateFilename }),
        ),
      );
    }
  } catch (error) {
    console.error(
      error instanceof GatewayClientError
        ? error.message
        : "Gateway publication input or transport failed",
    );
    if (error.publication) console.error(JSON.stringify(error.publication));
    process.exitCode = 1;
  }
}
