import { Buffer } from "node:buffer";
import {
  GatewayError,
  reject,
  response,
  jsonBody,
  boundedBytes,
} from "./read.mjs";
import {
  newValidation,
  validateChunk,
  sealValidation,
  compact,
} from "./validation.mjs";
import { MAX_UPLOAD_BYTES } from "../../../scripts/gateway-protocol.mjs";
const encoder = new TextEncoder(),
  ROOT = "https://api.github.com/repos/SiliconYC/poly-tally",
  TTL = 3600,
  MAX_RECEIPT_BYTES = 128 * 1024;
const hex = (v) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const exact = (v, keys) => {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).length !== keys.length ||
    !keys.every((k) => Object.hasOwn(v, k))
  )
    reject(400, "invalid_publication_request");
};
const bytesHex = (b) => Buffer.from(b).toString("hex");
async function key(env) {
  if (
    typeof env.GATEWAY_RECEIPT_KEY !== "string" ||
    env.GATEWAY_RECEIPT_KEY.length < 40 ||
    env.GATEWAY_RECEIPT_KEY === env.GATEWAY_PASSWORD
  )
    reject(503, "receipt_key_not_configured");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(env.GATEWAY_RECEIPT_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
async function sign(value, env) {
  const payload = encoder.encode(JSON.stringify(value));
  if (payload.length > MAX_RECEIPT_BYTES)
    reject(413, "snapshot_scope_exceeds_gateway_limit");
  const signature = await crypto.subtle.sign("HMAC", await key(env), payload);
  return `${Buffer.from(payload).toString("base64url")}.${Buffer.from(signature).toString("base64url")}`;
}
async function verify(token, purpose, env, policy) {
  if (
    typeof token !== "string" ||
    token.length > MAX_RECEIPT_BYTES * 1.4 ||
    !/^[-_a-zA-Z0-9]+\.[-_a-zA-Z0-9]{43}$/.test(token)
  )
    reject();
  const [payload, signature] = token.split("."),
    bytes = Buffer.from(payload, "base64url");
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      await key(env),
      Buffer.from(signature, "base64url"),
      bytes,
    ))
  )
    reject();
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (
    value.purpose !== purpose ||
    value.policy !== policy.configSha256 ||
    (purpose !== "baseline" &&
      (!Number.isSafeInteger(value.expires) ||
        value.expires < Math.floor(Date.now() / 1000) ||
        value.expires > Math.floor(Date.now() / 1000) + TTL + 5))
  )
    reject();
  return value;
}
const receiptBase = (policy) => ({
  policy: policy.configSha256,
  purpose: "progress",
  expires: Math.floor(Date.now() / 1000) + TTL,
  batch: crypto.randomUUID(),
});
function client(env, fetcher) {
  if (!env.WRITE_PAT) reject(503, "publication_not_configured");
  return async (path, method = "GET", body, missing = false) => {
    const headers = new Headers({
      Authorization: `Bearer ${env.WRITE_PAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "poly-tally-gateway/1",
      "Accept-Encoding": "identity",
    });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const res = await fetcher(ROOT + path, {
      method,
      headers,
      redirect: "manual",
      body:
        body === undefined
          ? undefined
          : typeof body === "string" || body instanceof Uint8Array
            ? body
            : JSON.stringify(body),
    });
    if (res.status === 404 && missing) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      reject(
        res.status === 409 || res.status === 422 ? 409 : 502,
        res.status >= 300 && res.status < 400
          ? "upstream_redirect_rejected"
          : "publication_upstream_failed",
      );
    }
    if (res.status === 204) return null;
    return jsonBody(res, 2 * MAX_UPLOAD_BYTES);
  };
}
async function current(api) {
  const ref = await api("/git/ref/heads/tally-state", "GET", undefined, true);
  if (ref && !hex(ref.object?.sha)) reject(502, "invalid_state_reference");
  return ref?.object.sha ?? null;
}
async function assertCurrent(api, state) {
  if ((await current(api)) !== state.base)
    reject(409, "durable_state_changed_restart_publication");
}
export async function publish(
  request,
  env,
  fetcher,
  policy,
  bootstrapData = null,
) {
  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    url.search ||
    !/^\/publish\/(start|chunk|seal|upload|commit|dispatch)$/.test(url.pathname)
  )
    reject();
  const action = url.pathname.slice("/publish/".length),
    api = client(env, fetcher);
  if (action === "upload") {
    const sealed = await verify(
      request.headers.get("X-Poly-Receipt"),
      "upload",
      env,
      policy,
    );
    // This is intentionally a SMALL bounded snapshot path, not a streaming large
    // file upload. Nothing reaches public GitHub before byte-level authorization.
    const bytes = await boundedBytes(request, MAX_UPLOAD_BYTES);
    if (
      bytes.length !== sealed.length ||
      bytesHex(await crypto.subtle.digest("SHA-256", bytes)) !== sealed.hash
    )
      reject();
    const blob = await api("/git/blobs", "POST", bytes);
    if (!hex(blob?.sha)) reject(502, "invalid_uploaded_blob");
    return response({
      receipt: await sign({ ...sealed, purpose: "blob", sha: blob.sha }, env),
      sha: blob.sha,
    });
  }
  const body = await jsonBody(request, 256 * 1024);
  if (action === "start") {
    exact(body, []);
    const base = await current(api),
      commit = base ? await api(`/git/commits/${base}`) : null;
    if (commit && !hex(commit.tree?.sha)) reject(502, "invalid_state_tree");
    const tree = commit
      ? await api(`/git/trees/${commit.tree.sha}`)
      : { tree: [] };
    if (tree.truncated || !Array.isArray(tree.tree) || tree.tree.length > 64)
      reject(502, "invalid_state_tree");
    const baselines = tree.tree.filter((entry) =>
      ["private-metrics.json", "rebuilt-private-metrics.json"].includes(
        entry.path,
      ),
    );
    for (const entry of baselines)
      if (
        entry.type !== "blob" ||
        entry.mode !== "100644" ||
        !hex(entry.sha) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size > MAX_UPLOAD_BYTES
      )
        reject(413, "legacy_baseline_exceeds_gateway_limit");
    // No large legacy JSON is parsed inside the Free Worker. Trust only a
    // full-validator-checked build-time bootstrap, or our own signed compact
    // summary, in both cases bound to EVERY current baseline Git blob SHA.
    const entry = tree.tree.find((e) => e.path === "gateway-receipt.json");
    let trusted;
    if (entry) {
      if (
        entry.type !== "blob" ||
        entry.mode !== "100644" ||
        !hex(entry.sha) ||
        entry.size > MAX_RECEIPT_BYTES * 1.4
      )
        reject(403, "invalid_baseline_receipt");
      const blob = await api(`/git/blobs/${entry.sha}`);
      if (
        blob?.encoding !== "base64" ||
        blob.sha !== entry.sha ||
        typeof blob.content !== "string"
      )
        reject(502, "invalid_baseline_receipt");
      trusted = await verify(
        Buffer.from(blob.content, "base64").toString("utf8"),
        "baseline",
        env,
        policy,
      );
    } else trusted = bootstrapData;
    if (
      !trusted ||
      trusted.policy !== policy.configSha256 ||
      trusted.baselines.length !== baselines.length ||
      baselines.some(
        (e) =>
          !trusted.baselines.some((b) => b.path === e.path && b.sha === e.sha),
      )
    )
      reject(409, "baseline_bootstrap_outdated_rebuild_required");
    const prior = baselines.length ? trusted.baselines : [];
    const state = {
      ...receiptBase(policy),
      base,
      tree: commit?.tree.sha ?? null,
      baselines: prior,
      validation: newValidation(),
    };
    return response({ receipt: await sign(state, env), baselineCount: 0 });
  }
  if (action === "commit") {
    exact(body, ["public", "private", "selection"]);
    const selection = await verify(body.selection, "selection", env, policy);
    const pub = await verify(body.public, "blob", env, policy),
      priv = await verify(body.private, "blob", env, policy);
    if (
      pub.kind !== "public" ||
      priv.kind !== "private" ||
      pub.batch !== priv.batch ||
      pub.base !== priv.base ||
      pub.tree !== priv.tree ||
      pub.pair !== priv.pair ||
      selection.batch !== pub.batch ||
      selection.pair !== pub.pair
    )
      reject();
    await assertCurrent(api, pub);
    const baselines = [
      { path: "private-metrics.json", sha: priv.sha, data: selection.private },
      ...selection.baselines.filter(
        (b) => b.path === "rebuilt-private-metrics.json",
      ),
    ];
    const receipt = await sign(
      { purpose: "baseline", policy: pub.policy, baselines },
      env,
    );
    const receiptBlob = await api("/git/blobs", "POST", {
      content: receipt,
      encoding: "utf-8",
    });
    if (!hex(receiptBlob?.sha)) reject(502, "invalid_baseline_receipt_blob");
    const tree = await api("/git/trees", "POST", {
      ...(pub.tree ? { base_tree: pub.tree } : {}),
      tree: [
        {
          path: "public-stats.json",
          mode: "100644",
          type: "blob",
          sha: pub.sha,
        },
        {
          path: "private-metrics.json",
          mode: "100644",
          type: "blob",
          sha: priv.sha,
        },
        {
          path: "gateway-receipt.json",
          mode: "100644",
          type: "blob",
          sha: receiptBlob.sha,
        },
      ],
    });
    if (!hex(tree?.sha)) reject(502, "invalid_publication_tree");
    const commit = await api("/git/commits", "POST", {
      message: "data: publish verified sanitized repository snapshots",
      tree: tree.sha,
      parents: pub.base ? [pub.base] : [],
    });
    if (!hex(commit?.sha)) reject(502, "invalid_publication_commit");
    // GitHub force:false is the final atomic non-fast-forward guard; checking the
    // ref above alone would have a TOCTOU race. No other ref can be selected.
    if (pub.base)
      await api("/git/refs/heads/tally-state", "PATCH", {
        sha: commit.sha,
        force: false,
      });
    else
      await api("/git/refs", "POST", {
        ref: "refs/heads/tally-state",
        sha: commit.sha,
      });
    const selected = {
      ...pub,
      purpose: "dispatch",
      commit: commit.sha,
      publicSha: pub.sha,
      privateSha: priv.sha,
    };
    return response({
      receipt: await sign(selected, env),
      snapshotCommit: commit.sha,
      publicBlobSha: pub.sha,
      privateBlobSha: priv.sha,
    });
  }
  if (action === "dispatch") {
    exact(body, ["receipt"]);
    const selected = await verify(body.receipt, "dispatch", env, policy);
    if ((await current(api)) !== selected.commit)
      reject(409, "snapshot_superseded");
    await api("/actions/workflows/publish-snapshot.yml/dispatches", "POST", {
      ref: "dev",
      inputs: {
        snapshot_commit: selected.commit,
        public_stats_blob_sha: selected.publicSha,
        private_metrics_blob_sha: selected.privateSha,
      },
    });
    return response({ dispatched: true, snapshotCommit: selected.commit });
  }
  exact(body, action === "chunk" ? ["receipt", "chunk"] : ["receipt"]);
  const state = await verify(body.receipt, "progress", env, policy);
  if (action === "chunk") {
    try {
      state.validation = validateChunk(state.validation, body.chunk, policy);
    } catch {
      reject(400, "snapshot_schema_rejected");
    }
    return response({ receipt: await sign(state, env) });
  }
  let sealed;
  try {
    sealed = sealValidation(
      state.validation,
      policy,
      state.baselines.map((b) => b.data),
    );
  } catch {
    reject(400, "snapshot_schema_or_replacement_rejected");
  }
  const pair = bytesHex(
    await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(JSON.stringify(sealed)),
    ),
  );
  const result = {};
  for (const kind of ["public", "private"])
    result[kind] = await sign(
      {
        purpose: "upload",
        expires: state.expires,
        policy: state.policy,
        batch: state.batch,
        base: state.base,
        tree: state.tree,
        kind,
        pair,
        ...sealed[kind],
      },
      env,
    );
  result.selection = await sign(
    {
      purpose: "selection",
      expires: state.expires,
      policy: state.policy,
      batch: state.batch,
      pair,
      private: {
        ...state.validation.private.header,
        repositories: state.validation.private.repositories,
      },
      baselines: state.baselines,
    },
    env,
  );
  return response(result);
}
