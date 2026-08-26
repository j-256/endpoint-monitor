import { hmacSha256Hex } from "./crypto.mjs"

const HOOKRELAY_SLUG_PATTERN = /^[A-Za-z0-9_-]{22,}$/

export function normalizeHookrelayUrl(value) {
  if (typeof value !== "string") throw new TypeError("Hookrelay URL is invalid")
  let url
  try {
    url = new URL(value)
  } catch {
    throw new TypeError("Hookrelay URL is invalid")
  }
  const segments = url.pathname.split("/")
  if (value !== value.trim()
    || url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
    || segments.length !== 4
    || segments[1] !== "hook"
    || segments[2] !== "cloudevents"
    || !HOOKRELAY_SLUG_PATTERN.test(segments[3])) {
    throw new TypeError("Hookrelay URL is invalid")
  }
  return url.toString()
}

export async function signHookrelayPayload(body, secret) {
  return hmacSha256Hex(body, secret)
}
