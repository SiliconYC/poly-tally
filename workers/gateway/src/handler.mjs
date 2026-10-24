import { publish } from "./publication.mjs";
import { policy } from "./policy.mjs";
import { GatewayError, read, response } from "./read.mjs";
const encoder = new TextEncoder();
async function authorized(request, env) {
  if (typeof env.GATEWAY_KEY !== "string" || env.GATEWAY_KEY.length < 40)
    return false;
  const header = request.headers.get("Authorization") ?? "";
  if (header.length > 512) return false;
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(header)),
    crypto.subtle.digest(
      "SHA-256",
      encoder.encode(`Bearer ${env.GATEWAY_KEY}`),
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
      if (new URL(request.url).protocol !== "https:")
        return response({ error: "https_required" }, 400);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health" && !url.search)
        return new Response("poly-tally-gateway-ok", {
          headers: {
            "Cache-Control": "no-store",
            "X-Poly-Tally-Protocol": "2",
            "X-Content-Type-Options": "nosniff",
          },
        });
      const secrets = [
        env.GITHUB_READ_TOKEN,
        env.GITHUB_PUBLISH_TOKEN,
        env.GATEWAY_KEY,
      ];
      if (
        secrets.some((value) => typeof value !== "string" || !value) ||
        new Set(secrets).size !== 3 ||
        !/^[!-~]{40,256}$/.test(env.GATEWAY_KEY) ||
        /^(?:gh[pousr]_|github_pat_)/i.test(env.GATEWAY_KEY)
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
