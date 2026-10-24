// Fixed host + method + path grammar. Never accepts a caller-selected upstream URL.
export class GatewayError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}
export const reject = (status = 403, code = "request_not_allowed") => {
  throw new GatewayError(status, code);
};
export const response = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
export async function boundedBytes(request, limit) {
  if (
    request.headers.get("Content-Encoding") &&
    request.headers.get("Content-Encoding") !== "identity"
  )
    reject(400, "encoded_body_not_allowed");
  const declared = request.headers.get("Content-Length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > limit)
  )
    reject(413, "body_too_large");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      reject(413, "body_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
export async function jsonBody(request, limit = 16384) {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await boundedBytes(request, limit),
      ),
    );
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    reject(400, "invalid_json");
  }
}
const repoPattern = /^[A-Za-z0-9_.-]{1,100}$/;
export function allowedRepository(name, env) {
  if (
    !/^SiliconYC\/[A-Za-z0-9_.-]{1,100}$/.test(name) ||
    [".", ".."].includes(name.split("/")[1])
  )
    return false;
  let list;
  try {
    list = JSON.parse(env.ALLOWED_REPOSITORIES);
  } catch {
    return false;
  }
  return (
    Array.isArray(list) &&
    list.length <= 128 &&
    list.every((x) => typeof x === "string") &&
    (list.includes(name) || list.includes("SiliconYC/*"))
  );
}
function query(url, allowed) {
  const seen = new Set();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key) || !Object.hasOwn(allowed, key) || !allowed[key](value))
      reject();
    seen.add(key);
  }
}
const page = (v) => /^[1-9]\d{0,4}$/.test(v),
  perPage = (v) => /^(?:[1-9]|[1-9]\d|100)$/.test(v);
export function routeRead(url, method, env) {
  const path = url.pathname;
  const branchLeaf =
    /^\/api\/repos\/SiliconYC\/[A-Za-z0-9_.-]+\/branches\/[^/]+$/.test(path);
  if (/%5c|%00|\\/i.test(path) || (!branchLeaf && /%2f|%2e/i.test(path)))
    reject();
  let match;
  if (
    (match = path.match(
      /^\/git\/(SiliconYC\/[A-Za-z0-9_.-]+)\.git\/(info\/refs|git-upload-pack)$/,
    ))
  ) {
    if (!allowedRepository(match[1], env)) reject();
    if (match[2] === "info/refs") {
      if (method !== "GET") reject();
      query(url, { service: (v) => v === "git-upload-pack" });
      if (url.searchParams.get("service") !== "git-upload-pack") reject();
    } else if (method !== "POST" || url.search) reject();
    return {
      kind: "git",
      url: `https://github.com/${match[1]}.git/${match[2]}${url.search}`,
    };
  }
  if (method !== "GET" || !path.startsWith("/api/")) reject();
  const apiPath = path.slice(4);
  let kind;
  if (apiPath === "/users/SiliconYC") {
    query(url, {});
    kind = "owner";
  } else if (
    ["/users/SiliconYC/repos", "/orgs/SiliconYC/repos", "/user/repos"].includes(
      apiPath,
    )
  ) {
    query(url, {
      page,
      per_page: perPage,
      type: (v) => ["owner", "public", "all"].includes(v),
      affiliation: (v) =>
        ["owner", "owner,collaborator,organization_member"].includes(v),
    });
    kind = "list";
    url = new URL(url);
    url.searchParams.set("per_page", "10");
    if (apiPath === "/user/repos") url.searchParams.set("affiliation", "owner");
  } else if (
    (match = apiPath.match(
      /^\/repos\/(SiliconYC\/[A-Za-z0-9_.-]+)(?:\/(branches)(?:\/([^/]+))?)?$/,
    ))
  ) {
    if (!allowedRepository(match[1], env)) reject();
    if (!match[2]) {
      query(url, {});
      kind = "repository";
    } else if (!match[3]) {
      query(url, { per_page: (v) => v === "1" });
      kind = "branches";
    } else {
      query(url, {});
      let branch;
      try {
        branch = decodeURIComponent(match[3]);
      } catch {
        reject();
      }
      if (
        !branch ||
        branch.length > 255 ||
        /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) ||
        branch.includes("%") ||
          branch.includes("..") ||
        branch.includes("@{") ||
        branch.endsWith(".") ||
        branch
          .split("/")
          .some((x) => !x || x.startsWith(".") || x.endsWith(".lock"))
      )
        reject();
      kind = "branch";
    }
  } else reject();
  return { kind, url: `https://api.github.com${apiPath}${url.search}` };
}
function metadata(row) {
  if (
    !row ||
    !Number.isSafeInteger(row.id) ||
    row.id <= 0 ||
    typeof row.full_name !== "string" ||
    !/^SiliconYC\/[A-Za-z0-9_.-]+$/.test(row.full_name) ||
    row.clone_url !== `https://github.com/${row.full_name}.git` ||
    row.owner?.login !== "SiliconYC" ||
    ![row.private, row.archived, row.fork].every(
      (v) => typeof v === "boolean",
    ) ||
    !Number.isSafeInteger(row.size) ||
    row.size < 0 ||
    !(row.default_branch === null || typeof row.default_branch === "string")
  )
    reject(502, "invalid_upstream_metadata");
  return Object.fromEntries(
    [
      "id",
      "full_name",
      "clone_url",
      "default_branch",
      "private",
      "archived",
      "fork",
      "size",
    ]
      .map((k) => [k, row[k]])
      .concat([["owner", { login: "SiliconYC" }]]),
  );
}
function readHeaders(upstream) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  for (const name of [
    "Content-Type",
    "X-RateLimit-Remaining",
    "X-RateLimit-Reset",
    "Retry-After",
  ])
    if (upstream.headers.has(name))
      headers.set(name, upstream.headers.get(name));
  return headers;
}
export async function read(request, env, fetcher) {
  const url = new URL(request.url),
    route = routeRead(url, request.method, env);
  if (!env.READ_PAT) reject(503, "gateway_not_configured");
  const headers = new Headers({
    "User-Agent": "poly-tally-gateway/1",
    "Accept-Encoding": "identity",
  });
  if (route.kind === "git") {
    headers.set(
      "Authorization",
      `Basic ${btoa(`x-access-token:${env.READ_PAT}`)}`,
    );
    if (request.method === "POST") {
      if (
        request.headers.get("Content-Type") !==
        "application/x-git-upload-pack-request"
      )
        reject();
      headers.set("Content-Type", "application/x-git-upload-pack-request");
    }
    const protocol = request.headers.get("Git-Protocol");
    if (protocol) {
      if (!["version=1", "version=2"].includes(protocol)) reject();
      headers.set("Git-Protocol", protocol);
    }
  } else {
    headers.set("Authorization", `Bearer ${env.READ_PAT}`);
    headers.set("Accept", "application/vnd.github+json");
    headers.set("X-GitHub-Api-Version", "2022-11-28");
  }
  const upstream = await fetcher(route.url, {
    method: request.method,
    headers,
    redirect: "manual",
    ...(request.method === "POST"
      ? { body: request.body, duplex: "half" }
      : {}),
  });
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel();
    reject(502, "upstream_redirect_rejected");
  }
  if (!upstream.ok) {
    await upstream.body?.cancel();
    const result = response(
      { error: "upstream_read_failed" },
      [401, 403, 404, 409, 429].includes(upstream.status)
        ? upstream.status
        : 502,
    );
    for (const name of [
      "Retry-After",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
    ])
      if (upstream.headers.has(name))
        result.headers.set(name, upstream.headers.get(name));
    return result;
  }
  const outgoing = readHeaders(upstream);
  if (route.kind === "git")
    return new Response(upstream.body, {
      status: upstream.status,
      headers: outgoing,
    });
  const body = await jsonBody(upstream, 262144);
  let data;
  if (route.kind === "list") {
    if (!Array.isArray(body) || body.length > 10)
      reject(502, "invalid_upstream_page");
    if (body.some((r) => r?.owner?.login !== "SiliconYC"))
      reject(403, "credential_owner_mismatch");
    const owned = body;
    if (owned.some((r) => !allowedRepository(r.full_name, env)))
      reject(403, "repository_authorization_required");
    data = owned.map(metadata);
  } else if (route.kind === "repository") data = metadata(body);
  else if (route.kind === "owner") {
    if (!["User", "Organization"].includes(body?.type))
      reject(502, "invalid_upstream_metadata");
    data = { type: body.type };
  } else if (route.kind === "branches") {
    if (!Array.isArray(body) || body.length > 1)
      reject(502, "invalid_upstream_branches");
    data = body.map((r) => ({ name: r.name }));
  } else {
    if (!/^[a-f0-9]{40}$/.test(body?.commit?.sha))
      reject(502, "invalid_upstream_branch");
    data = { commit: { sha: body.commit.sha } };
  }
  const link = upstream.headers.get("Link");
  if (link) {
    const links = [];
    for (const item of link.split(",")) {
      const match = item
        .trim()
        .match(/^<([^>]+)>; rel="(next|last|first|prev)"$/);
      if (!match) reject(502, "invalid_upstream_link");
      const target = new URL(match[1]);
      if (target.origin !== "https://api.github.com")
        reject(502, "invalid_upstream_link");
      const rewritten = new URL(
        `/api${target.pathname}${target.search}`,
        url.origin,
      );
      routeRead(rewritten, "GET", env);
      links.push(`<${rewritten}>; rel="${match[2]}"`);
    }
    outgoing.set("Link", links.join(", "));
  }
  outgoing.set("Content-Type", "application/json");
  return new Response(JSON.stringify(data), { headers: outgoing });
}
