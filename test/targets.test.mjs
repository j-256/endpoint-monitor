import assert from "node:assert/strict"
import test from "node:test"

import {
  parseTargetsArguments,
  runTargets,
  usage,
} from "../scripts/targets.mjs"

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef"
const DATABASE_ID = "01234567-89ab-cdef-0123-456789abcdef"
const PROFILE_PATH = "/private/endpoint-monitor.local.json"
const CONFIG_PATH = "/private/endpoint-monitor.json"
const WRANGLER_PATH = "/private/wrangler.jsonc"
const PROFILE = JSON.stringify({
  configPath: CONFIG_PATH,
  schemaVersion: 1,
  wranglerPath: WRANGLER_PATH,
})
const CONFIGURATION = JSON.stringify({
  defaults: { probeIntervalMinutes: 5 },
  schemaVersion: 1,
  targets: [{ id: "example-home", url: "https://example.com/" }],
})
const WRANGLER = JSON.stringify({
  d1_databases: [{
    binding: "MONITOR_DB",
    database_id: DATABASE_ID,
    database_name: "endpoint-monitor",
  }],
})

function streamFixture() {
  let output = ""
  return {
    read: () => output,
    write: (value) => {
      output += value
    },
  }
}

function dependencies(overrides = {}) {
  return {
    clock: () => Date.parse("2026-08-26T13:00:00.000Z"),
    environment: {},
    fetchImpl: async () => new Response(null, { status: 200 }),
    lstatImpl: async () => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      mode: 0o100600,
    }),
    readFileImpl: async (filename) => {
      if (filename === PROFILE_PATH) return PROFILE
      if (filename === CONFIG_PATH) return CONFIGURATION
      if (filename === WRANGLER_PATH) return WRANGLER
      throw new Error("unexpected file")
    },
    stderr: streamFixture(),
    stdout: streamFixture(),
    ...overrides,
  }
}

test("target workflow help documents the zero-argument operator surface", async () => {
  assert.match(usage(), /list/)
  assert.match(usage(), /probe/)
  assert.match(usage(), /sync/)
  const deps = dependencies()
  assert.equal(await runTargets(["--help"], deps), 0)
  assert.match(deps.stdout.read(), /Usage:/)
  assert.equal(deps.stderr.read(), "")
})

test("target workflow parser supports defaults, interleaving, and option values", () => {
  assert.equal(parseTargetsArguments([]).command, "list")
  assert.deepEqual(
    parseTargetsArguments(["-jp/private/profile.json", "sync"]),
    {
      command: "sync",
      help: false,
      json: true,
      profilePath: "/private/profile.json",
    },
  )
  assert.equal(
    parseTargetsArguments(["--profile=/private/profile.json", "probe"]).command,
    "probe",
  )
  assert.throws(() => parseTargetsArguments(["missing"]), /Unknown command/)
  assert.throws(() => parseTargetsArguments(["list", "probe"]), /Unexpected argument/)
})

test("target workflow lists endpoints and reveals the canonical edit path", async () => {
  const list = dependencies()
  assert.equal(await runTargets(["list", "--profile", PROFILE_PATH], list), 0)
  assert.match(list.stdout.read(), /example-home\tGET\t<500\thttps:\/\/example\.com\//)
  assert.match(list.stdout.read(), /1 target\(s\)/)

  const location = dependencies()
  assert.equal(await runTargets(["path", "-j", "-p", PROFILE_PATH], location), 0)
  assert.deepEqual(JSON.parse(location.stdout.read()), { configPath: CONFIG_PATH })
})

test("target workflow probes the explicit document", async () => {
  const deps = dependencies()
  assert.equal(await runTargets(["probe", "--json", "--profile", PROFILE_PATH], deps), 0)
  const output = JSON.parse(deps.stdout.read())
  assert.equal(output.summary.succeeded, 1)
  assert.equal(output.results[0].targetId, "example-home")
})

test("target workflow synchronizes through the configured D1 binding", async () => {
  let request
  const deps = dependencies({
    environment: {
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: "api-token",
    },
    fetchImpl: async (url, init) => {
      request = { init, url }
      return Response.json({
        result: [{ meta: { rows_written: 1 }, success: true }],
        success: true,
      })
    },
  })
  assert.equal(await runTargets(["sync", "-j", "-p", PROFILE_PATH], deps), 0)
  const output = JSON.parse(deps.stdout.read())
  assert.equal(output.rowsWritten, 1)
  assert.equal(output.targetCount, 1)
  assert.match(output.configFingerprint, /^sha256:[a-f0-9]{64}$/)
  assert.equal(request.url.includes(DATABASE_ID), true)
  assert.equal(JSON.parse(request.init.body).params[4], "2026-08-26T13:00:00.000Z")
})

test("target workflow fails closed on private files and provider configuration", async () => {
  const unsafe = dependencies({
    lstatImpl: async () => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      mode: 0o100644,
    }),
  })
  assert.equal(await runTargets(["list", "-p", PROFILE_PATH], unsafe), 1)
  assert.match(unsafe.stderr.read(), /mode-0600/)

  const missingAccount = dependencies()
  assert.equal(await runTargets(["sync", "-p", PROFILE_PATH], missingAccount), 1)
  assert.match(missingAccount.stderr.read(), /CLOUDFLARE_ACCOUNT_ID/)

  const invalidWrangler = dependencies({
    environment: {
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: "api-token",
    },
    readFileImpl: async (filename) => filename === PROFILE_PATH
      ? PROFILE
      : filename === CONFIG_PATH
        ? CONFIGURATION
        : "{}",
  })
  assert.equal(await runTargets(["sync", "-p", PROFILE_PATH], invalidWrangler), 1)
  assert.match(invalidWrangler.stderr.read(), /MONITOR_DB/)
})
