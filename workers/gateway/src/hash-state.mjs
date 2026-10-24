// @noble/hashes 2.4.0 is exact-pinned. This small adapter deliberately uses its
// reviewed SHA256 get/set + HashMD buffer/pos/length layout. Upgrade only with
// the cross-runtime differential suite. Restore ONLY after receipt HMAC verify.
import { sha256 } from "@noble/hashes/sha2.js";
function save(hash) {
  return {
    words: hash.get(),
    length: hash.length,
    pos: hash.pos,
    buffer: Array.from(hash.buffer.subarray(0, hash.pos)),
  };
}
function restore(state) {
  if (
    !state ||
    Object.keys(state).sort().join(",") !== "buffer,length,pos,words" ||
    !Array.isArray(state.words) ||
    state.words.length !== 8 ||
    !state.words.every(
      (n) => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647,
    ) ||
    !Number.isSafeInteger(state.length) ||
    state.length < 0 ||
    state.length > 1048576 ||
    state.pos !== state.length % 64 ||
    !Array.isArray(state.buffer) ||
    state.buffer.length !== state.pos ||
    !state.buffer.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  )
    throw new Error("Invalid signed hash state");
  const hash = sha256.create();
  hash.set(...state.words);
  hash.length = state.length;
  hash.pos = state.pos;
  hash.buffer.set(state.buffer);
  return hash;
}
export const newHash = () => save(sha256.create());
export const updateHash = (state, bytes) => save(restore(state).update(bytes));
export const finishHash = (state) =>
  Array.from(restore(state).digest(), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
