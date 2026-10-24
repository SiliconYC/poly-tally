import { bytesHex, base64url, unbase64 } from "./encoding.mjs";
import {
  validateCompletePrivateMetrics,
  validateRebuiltPrivateMetrics,
  validatePrivateMetricsReplacement,
} from "../../../scripts/metrics.mjs";
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
async function key(env) {
  if (!env.GITHUB_PUBLISH_TOKEN) reject(503, "publication_not_configured");
  // Domain-separated from GitHub authentication and never derived from the
  // client-known proxy key. No additional Secret, no token persistence/output.
  const material = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(
      `poly-tally/gateway/receipt-key/v2\0${env.GITHUB_PUBLISH_TOKEN}`,
    ),
  );
  return crypto.subtle.importKey(
    "raw",
    material,
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
  return `${base64url(payload)}.${base64url(new Uint8Array(signature))}`;
}
async function verify(token, purpose, env, policy, allowPriorPolicy = false) {
  if (
    typeof token !== "string" ||
    token.length > MAX_RECEIPT_BYTES * 1.4 ||
    !/^[-_a-zA-Z0-9]+\.[-_a-zA-Z0-9]{43}$/.test(token)
  )
    reject();
  const [payload, signature] = token.split("."),
    bytes = unbase64(payload);
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      await key(env),
      unbase64(signature),
      bytes,
    ))
  )
    reject();
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (
    value.purpose !== purpose ||
    (value.policy !== policy.configSha256 &&
      !(purpose === "baseline" && allowPriorPolicy)) ||
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
  if (!env.GITHUB_PUBLISH_TOKEN) reject(503, "publication_not_configured");
  return async (
    path,
    method = "GET",
    body,
    missing = false,
    rawLimit = null,
  ) => {
    const headers = new Headers({
      Authorization: `Bearer ${method === "GET" ? env.GITHUB_READ_TOKEN : env.GITHUB_PUBLISH_TOKEN}`,
      Accept:
        rawLimit === null
          ? "application/vnd.github+json"
          : "application/vnd.github.raw+json",
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
    return rawLimit === null
      ? jsonBody(res, 2 * MAX_UPLOAD_BYTES)
      : boundedBytes(res, rawLimit);
  };
}
async function verifyGitBlob(bytes, entry) {
  if (bytes.length !== entry.size) reject(502, "baseline_blob_size_mismatch");
  const prefix = encoder.encode(`blob ${bytes.length}\0`),
    framed = new Uint8Array(prefix.length + bytes.length);
  framed.set(prefix);
  framed.set(bytes, prefix.length);
  if (
    bytesHex(new Uint8Array(await crypto.subtle.digest("SHA-1", framed))) !==
    entry.sha
  )
    reject(502, "baseline_blob_hash_mismatch");
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
async function dispatchSelection(pub, commit, privateSha, env) {
  const selected = {
    ...pub,
    purpose: "dispatch",
    commit,
    publicSha: pub.sha,
    privateSha,
  };
  return response({
    receipt: await sign(selected, env),
    snapshotCommit: commit,
    publicBlobSha: pub.sha,
    privateBlobSha: privateSha,
  });
}
async function recoverCommitted(api, pub, priv, env, policy) {
  const head = await current(api);
  if (!head || head === pub.base) reject(409, "publication_not_confirmed");
  const commit = await api(`/git/commits/${head}`);
  const parents = pub.base ? [pub.base] : [];
  if (
    !hex(commit?.tree?.sha) ||
    !Array.isArray(commit.parents) ||
    commit.parents.length !== parents.length ||
    !commit.parents.every((p, i) => p.sha === parents[i])
  )
    reject(409, "publication_not_confirmed");
  const tree = await api(`/git/trees/${commit.tree.sha}`);
  if (tree.truncated || !Array.isArray(tree.tree) || tree.tree.length > 64)
    reject(502, "invalid_state_tree");
  const item = (path) =>
    tree.tree.find(
      (e) => e.path === path && e.type === "blob" && e.mode === "100644",
    );
  const receipt = item("gateway-receipt.json");
  if (
    item("public-stats.json")?.sha !== pub.sha ||
    item("private-metrics.json")?.sha !== priv.sha ||
    !receipt ||
    !hex(receipt.sha) ||
    !Number.isSafeInteger(receipt.size) ||
    receipt.size > MAX_RECEIPT_BYTES * 1.4
  )
    reject(409, "publication_not_confirmed");
  const bytes = await api(
    `/git/blobs/${receipt.sha}`,
    "GET",
    undefined,
    false,
    MAX_RECEIPT_BYTES * 1.4,
  );
  await verifyGitBlob(bytes, receipt);
  const verified = await verify(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    "baseline",
    env,
    policy,
  );
  const proof = verified.publication;
  if (
    !proof ||
    proof.batch !== pub.batch ||
    proof.pair !== pub.pair ||
    proof.base !== pub.base ||
    proof.publicSha !== pub.sha ||
    proof.privateSha !== priv.sha
  )
    reject(409, "publication_not_confirmed");
  if ((await current(api)) !== head) reject(409, "snapshot_superseded");
  return dispatchSelection(pub, head, priv.sha, env);
}
export async function publish(request, env, fetcher, policy) {
  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    url.search ||
    !/^\/publish\/(start|recover|baseline|chunk|seal|upload|commit|status|dispatch)$/.test(
      url.pathname,
    )
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
      bytesHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))) !==
        sealed.hash
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
  if (action === "start" || action === "recover") {
    const recovering = action === "recover";
    exact(body, recovering ? ["expectedCurrentCommit"] : []);
    if (recovering && !hex(body.expectedCurrentCommit))
      reject(400, "invalid_current_commit_confirmation");
    const base = await current(api),
      commit = base ? await api(`/git/commits/${base}`) : null;
    if (recovering && base !== body.expectedCurrentCommit)
      reject(409, "durable_state_changed_restart_recovery");
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
    if (
      !base ||
      baselines.length !== 2 ||
      !baselines.some((e) => e.path === "private-metrics.json") ||
      !baselines.some((e) => e.path === "rebuilt-private-metrics.json")
    )
      reject(409, "both_durable_baselines_required");
    for (const entry of baselines)
      if (
        entry.type !== "blob" ||
        entry.mode !== "100644" ||
        !hex(entry.sha) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        entry.size > MAX_UPLOAD_BYTES
      )
        reject(413, "legacy_baseline_exceeds_gateway_limit");
    // Existing signed receipts avoid re-parsing old histories. First migration
    // reads one fixed, exact Git blob per baseline request; no client data/URL.
    const entry = tree.tree.find((e) => e.path === "gateway-receipt.json");
    let previous = [],
      prior = [],
      pending = baselines.map(({ path, sha, size }) => ({ path, sha, size }));
    if (entry) {
      if (
        entry.type !== "blob" ||
        entry.mode !== "100644" ||
        !hex(entry.sha) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size > MAX_RECEIPT_BYTES * 1.4
      )
        reject(403, "invalid_baseline_receipt");
      const bytes = await api(
        `/git/blobs/${entry.sha}`,
        "GET",
        undefined,
        false,
        MAX_RECEIPT_BYTES * 1.4,
      );
      await verifyGitBlob(bytes, entry);
      let trusted;
      try {
        trusted = await verify(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          "baseline",
          env,
          policy,
          recovering,
        );
      } catch (error) {
        if (
          !recovering ||
          !(error instanceof GatewayError) ||
          error.status !== 403
        )
          throw error;
        // Explicit key-rotation recovery: current server snapshots become the
        // revalidated trust root. No claim of continuity with an unverifiable old key.
      }
      if (
        trusted &&
        !recovering &&
        (!Array.isArray(trusted.baselines) ||
          trusted.baselines.length !== baselines.length ||
          baselines.some(
            (e) =>
              !trusted.baselines.some(
                (b) => b.path === e.path && b.sha === e.sha,
              ),
          ))
      )
        reject(409, "durable_baseline_changed_recovery_required");
      if (recovering) previous = trusted?.baselines ?? [];
      else {
        prior = trusted.baselines;
        pending = [];
      }
    }
    const state = {
      ...receiptBase(policy),
      base,
      tree: commit?.tree.sha ?? null,
      baselines: prior,
      previousBaselines: previous,
      pendingBaselines: pending,
      validation: newValidation(),
    };
    return response({
      receipt: await sign(state, env),
      baselineCount: pending.length,
    });
  }
  if (action === "baseline") {
    exact(body, ["receipt"]);
    const state = await verify(body.receipt, "progress", env, policy);
    if (!state.pendingBaselines?.length || state.validation.public)
      reject(409, "baseline_phase_required");
    await assertCurrent(api, state);
    const entry = state.pendingBaselines[0];
    const bytes = await api(
      `/git/blobs/${entry.sha}`,
      "GET",
      undefined,
      false,
      MAX_UPLOAD_BYTES,
    );
    await verifyGitBlob(bytes, entry);
    let data;
    try {
      data = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      if (entry.path === "private-metrics.json")
        validateCompletePrivateMetrics(data);
      else if (entry.path === "rebuilt-private-metrics.json")
        validateRebuiltPrivateMetrics(data);
      else reject();
      if (data.repositories.length > 64)
        reject(413, "snapshot_scope_exceeds_gateway_limit");
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      reject(400, "legacy_baseline_schema_rejected");
    }
    state.baselines.push({
      path: entry.path,
      sha: entry.sha,
      data: compact(data),
    });
    state.pendingBaselines.shift();
    if (!state.pendingBaselines.length && state.previousBaselines?.length) {
      try {
        for (const old of state.previousBaselines) {
          const next = state.baselines.find((b) => b.path === old.path);
          if (!next) reject(409, "recovery_cannot_remove_known_baseline");
          validatePrivateMetricsReplacement(old.data, next.data, undefined, {
            resetEpoch: policy.datasetEpoch,
            preserveScope: true,
            allowRebuilt: old.path === "rebuilt-private-metrics.json",
          });
        }
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        reject(409, "recovery_cannot_roll_back_known_baseline");
      }
      state.previousBaselines = [];
    }
    return response({
      receipt: await sign(state, env),
      baselineCount: state.pendingBaselines.length,
    });
  }
  if (action === "commit" || action === "status") {
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
    if (action === "status")
      return recoverCommitted(api, pub, priv, env, policy);
    await assertCurrent(api, pub);
    const baselines = [
      { path: "private-metrics.json", sha: priv.sha, data: selection.private },
      ...selection.baselines.filter(
        (b) => b.path === "rebuilt-private-metrics.json",
      ),
    ];
    const receipt = await sign(
      {
        purpose: "baseline",
        policy: pub.policy,
        baselines,
        publication: {
          batch: pub.batch,
          pair: pub.pair,
          base: pub.base,
          publicSha: pub.sha,
          privateSha: priv.sha,
        },
      },
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
    return dispatchSelection(pub, commit.sha, priv.sha, env);
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
  if (state.pendingBaselines?.length)
    reject(409, "baseline_validation_required");
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
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(JSON.stringify(sealed)),
      ),
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
