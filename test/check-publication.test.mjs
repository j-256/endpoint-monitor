import assert from "node:assert/strict"
import test from "node:test"

import {
  contentIssues,
  isPrivateArtifact,
  usage,
} from "../scripts/check-publication.mjs"

test("publication checker documents its interface", () => {
  assert.match(usage(), /private deployment artifacts/)
})

test("publication checker detects private paths, keys, tokens, and routes", () => {
  assert.equal(contentIssues("safe.mjs", "https://example.com/").length, 0)
  assert.match(
    contentIssues("path.md", "/" + "x/private/file")[0],
    /machine-local/,
  )
  assert.match(
    contentIssues("key.txt", "-----BEGIN " + "PRIVATE KEY-----")[0],
    /private-key/,
  )
  assert.match(
    contentIssues("token.txt", "github" + "_pat_abcdefghijklmnopqrstuvwxyz")[0],
    /token-shaped/,
  )
  assert.match(
    contentIssues(
      "route.txt",
      "https://hooks.production.invalid/hook/" + "cloudevents/abcdefghijklmnopqrstuv",
    )[0],
    /Hookrelay route/,
  )
})

test("publication checker recognizes private deployment filenames", () => {
  for (const filename of [
    ".dev.vars",
    ".dev.vars.production",
    ".env",
    ".env.local",
    "endpoint-monitor.json",
    "wrangler.jsonc",
  ]) {
    assert.equal(isPrivateArtifact(filename), true)
  }
  assert.equal(isPrivateArtifact("wrangler.example.jsonc"), false)
})
