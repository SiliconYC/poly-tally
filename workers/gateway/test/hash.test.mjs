import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { newHash, updateHash, finishHash } from "../src/hash-state.mjs";

test("pinned SHA256 state serialization matches native across every block boundary and random splits", () => {
  for (const length of [
    0, 1, 31, 55, 56, 63, 64, 65, 127, 128, 129, 1023, 16384, 65537, 1048576,
  ]) {
    const bytes = randomBytes(length);
    let state = newHash();
    for (let at = 0; at < length;) {
      const end = Math.min(length, at + 1 + ((at * 13 + 17) % 4096));
      state = JSON.parse(
        JSON.stringify(updateHash(state, bytes.subarray(at, end))),
      );
      at = end;
    }
    assert.equal(
      finishHash(state),
      createHash("sha256").update(bytes).digest("hex"),
      `length ${length}`,
    );
  }
  assert.equal(
    finishHash(updateHash(newHash(), new TextEncoder().encode("abc"))),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
test("invalid hash states are rejected instead of restoring partially controlled internals", () => {
  for (const state of [
    {},
    { words: [0], length: 0, pos: 0, buffer: [] },
    { words: Array(8).fill(0), length: -1, pos: 0, buffer: [] },
    { words: Array(8).fill(0), length: 64, pos: 1, buffer: [0] },
  ])
    assert.throws(() => updateHash(state, new Uint8Array()));
});
