// Synthetic local CPU PRECHECK, not Cloudflare Free billing/1102 evidence.
import { createHash } from "node:crypto";
import { bootstrap, policy } from "./synthetic-bootstrap.mjs";
import worker from "../src/handler.mjs";
import { validateCompletePrivateMetrics } from "../../../scripts/metrics.mjs";
const env = {
  GITHUB_READ_TOKEN: "fake-read",
  GITHUB_PUBLISH_TOKEN: "fake-write",
  GATEWAY_KEY: "fake-proxy-012345678901234567890123456789012345",
};
const elapsed = (start) => {
  const cpu = process.cpuUsage(start);
  return (cpu.user + cpu.system) / 1000;
};
const dataFor = (historyCount, languages = 1) => {
  const data = structuredClone(bootstrap.baselines[0].data);
  for (const repository of data.repositories)
    repository.history = Array.from({ length: historyCount }, (_, i) => ({
      timestamp: `${new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10)}T23:59:59.999999Z`,
      metrics: {
        code: languages,
        comment: 0,
        blank: 0,
        documentation: 0,
        files: languages,
      },
      languages: Object.fromEntries(
        ["Python", "JavaScript", "Go", "Rust", "C"]
          .slice(0, languages)
          .map((name) => [
            name,
            { code: 1, comment: 0, blank: 0, documentation: 0, files: 1 },
          ]),
      ),
    }));
  return data;
};
const bodyHash = (bytes) =>
  createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
async function measure(data) {
  const bytes = Buffer.from(JSON.stringify(data)),
    sha = bodyHash(bytes),
    samples = [],
    validator = [];
  let requests = 0;
  const rebuilt = structuredClone(data);
  rebuilt.completeness.complete = false;
  rebuilt.completeness.discoveryComplete = false;
  const rebuiltBytes = Buffer.from(JSON.stringify(rebuilt)),
    rebuiltSha = bodyHash(rebuiltBytes);
  const fetcher = async (url, options) => {
    requests++;
    const path = new URL(url).pathname.split("/poly-tally")[1];
    if (path === "/git/ref/heads/tally-state")
      return Response.json({ object: { sha: "1".repeat(40) } });
    if (path.startsWith("/git/commits/"))
      return Response.json({ tree: { sha: "2".repeat(40) } });
    if (path.startsWith("/git/trees/"))
      return Response.json({
        tree: [
          {
            path: "private-metrics.json",
            sha,
            mode: "100644",
            type: "blob",
            size: bytes.length,
          },
          {
            path: "rebuilt-private-metrics.json",
            sha: rebuiltSha,
            mode: "100644",
            type: "blob",
            size: rebuiltBytes.length,
          },
        ],
      });
    if (path === `/git/blobs/${sha}`) return new Response(bytes);
    throw new Error("Unexpected preflight request");
  };
  const call = async (action, body) => {
    const res = await worker.fetch(
      new Request(`https://gateway.example/publish/${action}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.GATEWAY_KEY}` },
        body: JSON.stringify(body),
      }),
      env,
      { fetcher, policy },
    );
    if (!res.ok) throw new Error(`Synthetic preflight HTTP ${res.status}`);
    return res.json();
  };
  for (let i = 0; i < 13; i++) {
    const start = await call("start", {}),
      cpu = process.cpuUsage();
    await call("baseline", { receipt: start.receipt });
    const used = elapsed(cpu);
    const raw = bytes.toString(),
      begin = process.cpuUsage();
    validateCompletePrivateMetrics(JSON.parse(raw));
    const validation = elapsed(begin);
    if (i >= 3) {
      samples.push(used);
      validator.push(validation);
    }
  }
  const summary = (values) => {
    values.sort((a, b) => a - b);
    return {
      medianMs: values[Math.floor(values.length / 2)],
      maxMs: values.at(-1),
    };
  };
  return {
    bytes: bytes.length,
    baselineRequestCpuIncludingMock: summary(samples),
    parseAndOriginalValidatorCpu: summary(validator),
    externalSubrequestsPerStart: 3,
    externalSubrequestsPerBaseline: 2,
    warning: samples.some((n) => n >= 10)
      ? "LOCAL_CPU_AT_OR_ABOVE_10MS; production publishing must remain unaccepted pending real Free measurements"
      : "LOCAL_ONLY_NOT_A_FREE_CPU_PASS",
  };
}
const currentLike = dataFor(80, 1);
let count = 110,
  maximum = dataFor(count, 5);
while (Buffer.byteLength(JSON.stringify(maximum)) > 1024 * 1024)
  maximum = dataFor(--count, 5);
console.log(
  JSON.stringify(
    {
      syntheticOnly: true,
      cloudflareFreeCpuVerified: false,
      cases: [await measure(currentLike), await measure(maximum)],
    },
    null,
    2,
  ),
);
