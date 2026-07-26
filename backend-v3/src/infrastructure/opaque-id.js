import { randomBytes as nodeRandomBytes } from "node:crypto";

export function createOpaqueId(
  randomBytes = nodeRandomBytes,
  byteLength = 16,
) {
  if (typeof randomBytes !== "function") {
    throw new TypeError("randomBytes must be a function");
  }
  if (!Number.isSafeInteger(byteLength) || byteLength < 16) {
    throw new TypeError("opaque IDs require at least 16 random bytes");
  }

  const bytes = Buffer.from(randomBytes(byteLength));
  if (bytes.byteLength < byteLength) {
    throw new Error("randomBytes returned fewer bytes than requested");
  }
  return bytes.subarray(0, byteLength).toString("base64url");
}
