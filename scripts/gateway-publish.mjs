import { readFile, open } from "node:fs/promises";
import { constants } from "node:fs";
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

// Linux gateway capability files must never fall back to symlink/hardlink targets.
async function withReceiptFile(filename, writing, callback) {
  let handle;
  try {
    handle = await open(
      filename,
      (writing ? constants.O_WRONLY | constants.O_CREAT : constants.O_RDONLY) |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      typeof process.getuid !== "function" ||
      info.uid !== process.getuid()
    )
      throw new Error("unsafe");
    await handle.chmod(0o600);
    return await callback(handle);
  } catch {
    throw new GatewayClientError(
      "Gateway receipt file is unsafe or unavailable",
    );
  } finally {
    await handle?.close();
  }
}
async function writeReceipt(filename, value) {
  return withReceiptFile(filename, true, async (handle) => {
    await handle.truncate(0);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  });
}
async function readReceipt(filename) {
  return withReceiptFile(filename, false, async (handle) =>
    JSON.parse(await handle.readFile("utf8")),
  );
}

export async function publishGateway({
  publicData,
  privateData,
  policy,
  env = process.env,
  fetcher = fetch,
  onCommitted,
  onPendingCommit,
  recoveryCommit,
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
  let result = recoveryCommit
      ? await api("recover", { expectedCurrentCommit: recoveryCommit })
      : await api("start", {}),
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
  const pending = { ...uploaded, selection: sealed.selection };
  if (onPendingCommit) await onPendingCommit(pending);
  const committed = await api("commit", pending);
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
  recoveryCommit,
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
    recoveryCommit,
    onPendingCommit: async (pending) => {
      await writeReceipt(receiptFilename, { pending });
    },
    onCommitted: async (committed) => {
      await writeReceipt(receiptFilename, committed);
    },
  });
}
export async function retryGatewayDispatch(
  filename,
  { env = process.env, fetcher = fetch } = {},
) {
  let saved = await readReceipt(filename);
  const api = gatewayClient({ env, fetcher });
  if (saved.pending) {
    saved = await api("status", saved.pending); // READ-ONLY confirmation; never repeat an uncertain commit.
    await writeReceipt(filename, saved);
  }
  return api("dispatch", { receipt: saved.receipt });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [publicFilename, privateFilename, ...extra] = process.argv.slice(2);
    if (publicFilename === "retry" && privateFilename && !extra.length) {
      console.log(JSON.stringify(await retryGatewayDispatch(privateFilename)));
    } else if (
      publicFilename === "recover" &&
      /^[a-f0-9]{40}$/.test(privateFilename || "") &&
      extra.length === 2
    ) {
      console.log(
        JSON.stringify(
          await publishGatewayFiles({
            recoveryCommit: privateFilename,
            publicFilename: extra[0],
            privateFilename: extra[1],
          }),
        ),
      );
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
