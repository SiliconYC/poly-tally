import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { base64url, unbase64, bytesHex } from "../src/encoding.mjs";
test("portable receipt codecs match native at buffer boundaries and maximum signed-state size", () => {
  for (const size of [0, 1, 2, 3, 8191, 8192, 8193, 35000, 90000, 128 * 1024]) {
    const bytes = randomBytes(size),
      encoded = base64url(bytes);
    assert.equal(encoded, bytes.toString("base64url"));
    assert.deepEqual(unbase64(encoded), new Uint8Array(bytes));
  }
  assert.equal(bytesHex(new Uint8Array([0, 15, 255])), "000fff");
  assert.throws(() => unbase64("%%%"));
});
