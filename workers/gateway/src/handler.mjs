import { publish } from "./publication.mjs";
import { policy } from "./policy.mjs";
import { GatewayError, read, response } from "./read.mjs";
const encoder = new TextEncoder();
async function authorized(request, env) {
  if (
    typeof env.GATEWAY_PASSWORD !== "string" ||
    env.GATEWAY_PASSWORD.length < 40
  )
    return false;
  const header = request.headers.get("Authorization") ?? "";
  if (header.length > 512) return false;
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(header)),
    crypto.subtle.digest(
      "SHA-256",
      encoder.encode(`Bearer ${env.GATEWAY_PASSWORD}`),
    ),
  ]);
  const a = new Uint8Array(actual),
    b = new Uint8Array(expected);
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i] ^ b[i];
  return different === 0;
}
export default {
  async fetch(request, env, ctx = {}) {
    try {
      if (new URL(request.url).protocol !== "https:" && !env.LOCAL_TEST_ONLY)
        return response({ error: "https_required" }, 400);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health" && !url.search)
        return response({ service: "poly-tally-gateway", version: 1 });
      const secrets = [
        env.READ_PAT,
        env.WRITE_PAT,
        env.GATEWAY_PASSWORD,
        env.GATEWAY_RECEIPT_KEY,
      ];
      if (
        secrets.some((value) => typeof value !== "string" || !value) ||
        new Set(secrets).size !== 4 ||
        env.GATEWAY_PASSWORD.length < 40 ||
        env.GATEWAY_RECEIPT_KEY.length < 40 ||
        /^(?:gh[pousr]_|github_pat_)/i.test(env.GATEWAY_PASSWORD)
      )
        return response({ error: "gateway_not_configured" }, 503);
      if (!(await authorized(request, env)))
        return response({ error: "unauthorized" }, 401);
      if (new URL(request.url).pathname.startsWith("/publish/"))
        return await publish(
          request,
          env,
          ctx.fetcher ?? fetch,
          ctx.policy ?? policy,
          ctx.bootstrap,
        );
      return await read(request, env, ctx.fetcher ?? fetch);
    } catch (error) {
      return response(
        {
          error:
            error instanceof GatewayError
              ? error.message
              : "gateway_request_failed",
        },
        error instanceof GatewayError ? error.status : 502,
      );
    }
  },
};
