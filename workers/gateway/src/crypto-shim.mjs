// Browser-only adapter for the original synchronous validator's SHA256 calls.
// The validators themselves are bundled unchanged (only their CLI entry is omitted).
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesHex } from "./encoding.mjs";
export function createHash(algorithm) {
  if (algorithm !== "sha256") throw new Error("Unsupported validator hash");
  const hash = sha256.create();
  return {
    update(value) {
      hash.update(
        typeof value === "string" ? new TextEncoder().encode(value) : value,
      );
      return this;
    },
    digest(encoding) {
      if (encoding !== "hex")
        throw new Error("Unsupported validator hash encoding");
      return bytesHex(hash.digest());
    },
  };
}
