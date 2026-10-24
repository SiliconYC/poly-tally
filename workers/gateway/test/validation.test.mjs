import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  newValidation,
  validateChunk,
  sealValidation,
} from "../src/validation.mjs";
import {
  blobBody,
  snapshotChunks,
} from "../../../scripts/gateway-protocol.mjs";
import { policy, fixtures, validatePair } from "./fixtures.mjs";
test("bounded canonical protocol produces exactly the bytes that native SHA256 seals", () => {
  const { pub, priv } = fixtures(),
    sealed = validatePair(pub, priv);
  for (const [kind, data] of [
    ["public", pub],
    ["private", priv],
  ]) {
    const body = blobBody(data);
    assert.equal(
      sealed[kind].hash,
      createHash("sha256").update(body).digest("hex"),
    );
    assert.equal(sealed[kind].length, Buffer.byteLength(body));
  }
});
test("unknown/private detail, malformed proofs, summaries, source duplication, empty active history and stale rules fail closed", () => {
  for (const mutate of [
    (f) => (f.pub.runs = []),
    (f) => (f.pub.repositories[0].head = "a".repeat(40)),
    (f) => (f.priv.repositories[0].history[0].sha = "b".repeat(40)),
    (f) => (f.priv.completeness.complete = false),
    (f) => f.pub.summary.code++,
    (f) => (f.priv.repositories[0].name = "SiliconYC/public"),
    (f) => (f.priv.repositories[0].history = []),
    (f) => (f.priv.rulesVersion = "f".repeat(16)),
  ]) {
    const f = fixtures();
    mutate(f);
    assert.throws(() => validatePair(f.pub, f.priv));
  }
});
test("cross-chunk timestamp/day ordering and incomplete state are rejected", () => {
  const f = fixtures();
  f.priv.repositories[0].history.push(
    structuredClone(f.priv.repositories[0].history[0]),
  );
  assert.throws(() => validatePair(f.pub, f.priv));
  const state = newValidation();
  assert.throws(() => sealValidation(state, policy, []));
  assert.throws(() =>
    validateChunk(state, { action: "history", history: [] }, policy),
  );
});
test("canonical payload never preserves hidden duplicate-key bytes", () => {
  const f = fixtures();
  f.pub.repositories[0].history[0].metrics = JSON.parse(
    '{"code":"SECRET_SHOULD_NEVER_UPLOAD","code":5,"comment":0,"blank":1,"documentation":0,"files":1}',
  );
  const sealed = validatePair(f.pub, f.priv);
  assert.doesNotMatch(blobBody(f.pub), /SECRET/);
  assert.equal(
    sealed.public.hash,
    createHash("sha256").update(blobBody(f.pub)).digest("hex"),
  );
});

test("oversized chunks and more than 64 repositories fail before sealing", () => {
  const { pub } = fixtures();
  let state = newValidation();
  const chunks = [...snapshotChunks(pub, "public")];
  state = validateChunk(state, chunks[0], policy);
  assert.throws(() =>
    validateChunk(
      state,
      {
        action: "repository",
        repository: { ...pub.repositories[0], name: "x".repeat(17000) },
      },
      policy,
    ),
  );
  state.public.repositories = Array(64).fill({});
  assert.throws(() => validateChunk(state, chunks[1], policy));
});
