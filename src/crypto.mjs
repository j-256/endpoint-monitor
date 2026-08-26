function bytesToHex(bytes) {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

export async function sha256Hex(value) {
  if (typeof value !== "string") {
    throw new TypeError("SHA-256 input must be a string")
  }
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return bytesToHex(new Uint8Array(digest))
}

export async function hmacSha256Hex(value, secret) {
  if (typeof value !== "string" || typeof secret !== "string" || !secret) {
    throw new TypeError("HMAC input is invalid")
  }
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value))
  return bytesToHex(new Uint8Array(signature))
}
