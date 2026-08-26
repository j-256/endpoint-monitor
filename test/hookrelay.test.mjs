import assert from "node:assert/strict"
import test from "node:test"

import {
  normalizeHookrelayUrl,
  signHookrelayPayload,
} from "../src/hookrelay.mjs"

test("Hookrelay URL validation accepts only structured CloudEvents routes", () => {
  const value = "https://hooks.example.com/hook/cloudevents/abcdefghijklmnopqrstuv"
  assert.equal(normalizeHookrelayUrl(value), value)
  for (const invalid of [
    "http://hooks.example.com/hook/cloudevents/abcdefghijklmnopqrstuv",
    "https://hooks.example.com/hook/github/abcdefghijklmnopqrstuv",
    "https://hooks.example.com/hook/cloudevents/short",
    "https://hooks.example.com/hook/cloudevents/abcdefghijklmnopqrstuv?secret=yes",
  ]) {
    assert.throws(() => normalizeHookrelayUrl(invalid))
  }
})

test("Hookrelay signatures use HMAC-SHA256", async () => {
  assert.equal(
    await signHookrelayPayload(
      "The quick brown fox jumps over the lazy dog",
      "key",
    ),
    "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
  )
})
