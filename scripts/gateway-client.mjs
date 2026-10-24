import {
  openSync,
  closeSync,
  fstatSync,
  statSync,
  readSync,
  realpathSync,
  constants,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
export class GatewayClientError extends Error {}
function proxyPasswordFile(filename) {
  let descriptor;
  try {
    const root = resolve(import.meta.dirname, ".."),
      fromRoot = relative(root, filename);
    if (!isAbsolute(filename) || realpathSync(filename) !== filename)
      throw new GatewayClientError();
    if (
      fromRoot === "" ||
      (!fromRoot.startsWith("../") && !isAbsolute(fromRoot))
    )
      throw new GatewayClientError();
    const parent = statSync(dirname(filename));
    if (
      !parent.isDirectory() ||
      (parent.mode & 0o777) !== 0o700 ||
      parent.uid !== process.getuid()
    )
      throw new GatewayClientError();
    descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    if (
      !info.isFile() ||
      (info.mode & 0o777) !== 0o600 ||
      info.uid !== process.getuid() ||
      info.size < 40 ||
      info.size > 257
    )
      throw new GatewayClientError();
    const bytes = Buffer.alloc(258),
      length = readSync(descriptor, bytes, 0, 258, 0);
    if (bytes.subarray(0, length).some((byte) => byte > 127))
      throw new GatewayClientError();
    return bytes.subarray(0, length).toString("ascii").replace(/\n$/, "");
  } catch {
    throw new GatewayClientError(
      "Proxy password file must be explicit, outside the repository, owner-only 0600 with a 0700 parent",
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
export function gatewayConfig(env = process.env, required = false) {
  const origin = env.POLY_TALLY_GATEWAY_URL,
    filename = env.POLY_TALLY_GATEWAY_PASSWORD_FILE;
  let password = env.POLY_TALLY_GATEWAY_PASSWORD;
  if (!origin && !password && !filename && !required) return null;
  if (
    ["POLY_TALLY_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"].some((key) =>
      Object.hasOwn(env, key),
    )
  )
    throw new GatewayClientError(
      "Gateway mode forbids GitHub token environment variables",
    );
  if (filename) {
    if (password)
      throw new GatewayClientError(
        "Choose one proxy password source, never both",
      );
    password = proxyPasswordFile(filename);
  }
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new GatewayClientError(
      "Gateway HTTPS origin and separate proxy password are required",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !["", "/"].includes(url.pathname) ||
    url.search ||
    url.hash ||
    !password ||
    password.length < 40 ||
    password.length > 256 ||
    /[^\x21-\x7e]/.test(password) ||
    /^(?:gh[pousr]_|github_pat_)/i.test(password)
  )
    throw new GatewayClientError("Invalid gateway configuration");
  return { origin: url.origin, password };
}
export function gatewayClient({ env = process.env, fetcher = fetch } = {}) {
  const { origin, password } = gatewayConfig(env, true);
  return async (path, body, receipt) => {
    const response = await fetcher(`${origin}/publish/${path}`, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${password}`,
        "Content-Type": "application/json",
        ...(receipt ? { "X-Poly-Receipt": receipt } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    if (!response.ok)
      throw new GatewayClientError(
        `Gateway publication ${path} failed: HTTP ${response.status}; no credential or response body is logged`,
      );
    return response.json();
  };
}
