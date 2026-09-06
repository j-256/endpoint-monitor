import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { configurationCandidate } from "../src/adapters/cloudflare/configuration-authority.mjs"
import { d1ApiFetch, d1Fixture } from "./d1.fixture.mjs"

import {
  help,
  parseCliArguments,
  runCli,
} from "../src/cli.mjs"

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef"
const DATABASE_ID = "01234567-89ab-cdef-0123-456789abcdef"
const PROFILE_PATH = "/private/endpoint-monitor.local.json"
const CONFIG_PATH = "/private/endpoint-monitor.json"
const WRANGLER_PATH = "/private/wrangler.jsonc"
const EXAMPLE_PATH = "/public/wrangler.example.jsonc"
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
const LOADED = await configurationCandidate(JSON.parse(CONFIGURATION))
const INITIAL_REVIEW = ["--expect-revision", "0", "--expect-fingerprint", LOADED.configFingerprint]
const WRANGLER = JSON.stringify({
  d1_databases: [{
    binding: "MONITOR_DB",
    database_id: DATABASE_ID,
    database_name: "endpoint-monitor",
  }],
})
const WRANGLER_EXAMPLE = JSON.stringify({
  d1_databases: [{
    binding: "MONITOR_DB",
    database_id: "00000000-0000-0000-0000-000000000000",
    database_name: "endpoint-monitor",
  }],
  name: "endpoint-monitor",
  vars: {},
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
    clock: () => Date.parse("2026-08-27T03:00:00.000Z"),
    environment: {},
    examplePath: EXAMPLE_PATH,
    fetchImpl: async () => new Response(null, { status: 200 }),
    lstatImpl: async () => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      mode: 0o100600,
    }),
    readFileImpl: async (filename) => {
      if (filename === PROFILE_PATH) return PROFILE
      if (filename === CONFIG_PATH || filename === "targets.json") return CONFIGURATION
      if (filename === WRANGLER_PATH) return WRANGLER
      if (filename === EXAMPLE_PATH) return WRANGLER_EXAMPLE
      throw new Error("unexpected file")
    },
    stderr: streamFixture(),
    stdout: streamFixture(),
    ...overrides,
  }
}

async function commandOutput(argv, overrides = {}) {
  const deps = dependencies(overrides)
  const status = await runCli(argv, deps)
  return {
    stderr: deps.stderr.read(),
    status,
    stdout: deps.stdout.read(),
  }
}

test("CLI help covers every route and supports equivalent spellings", async () => {
  assert.match(help(), /cloudflare bootstrap/)
  assert.match(help(), /deploy/)
  assert.match(help(), /init/)
  assert.match(help(["targets"]), /\[<target-document>\]/)
  const pairs = [
    [["help"], ["--help"]],
    [["help", "init"], ["init", "--help"]],
    [["help", "deploy"], ["deploy", "--help"]],
    [["help", "config"], ["config", "--help"]],
    [["help", "config", "path"], ["config", "path", "--help"]],
    [["help", "config", "show"], ["config", "show", "--help"]],
    [["help", "config", "validate"], ["config", "validate", "--help"]],
    [["help", "config", "sync"], ["config", "sync", "--help"]],
    [["help", "config", "review"], ["config", "review", "--help"]],
    [["help", "config", "remote"], ["config", "remote", "--help"]],
    [["help", "incidents"], ["incidents", "--help"]],
    [["help", "incidents", "list"], ["incidents", "list", "--help"]],
    [["help", "incidents", "show"], ["incidents", "show", "--help"]],
    [["help", "incidents", "acknowledge"], ["incidents", "acknowledge", "--help"]],
    [["help", "incidents", "snooze"], ["incidents", "snooze", "--help"]],
    [["help", "incidents", "dismiss"], ["incidents", "dismiss", "--help"]],
    [["help", "targets"], ["targets", "--help"]],
    [["help", "probe"], ["probe", "--help"]],
    [["help", "cloudflare"], ["cloudflare", "--help"]],
    [["help", "cloudflare", "bootstrap"], ["cloudflare", "bootstrap", "--help"]],
    [["help", "cloudflare", "configure"], ["cloudflare", "configure", "--help"]],
  ]
  for (const [leftArgv, rightArgv] of pairs) {
    const left = await commandOutput(leftArgv)
    const right = await commandOutput(rightArgv)
    assert.equal(left.status, 0)
    assert.equal(right.status, 0)
    assert.equal(left.stderr, "")
    assert.equal(right.stderr, "")
    assert.equal(left.stdout, right.stdout)
    assert.match(left.stdout, /^Usage: endpoint-monitor/)
  }
})

test("CLI help gives every long option a short equivalent", () => {
  const routes = [
    [],
    ["config", "path"],
    ["config", "show"],
    ["config", "validate"],
    ["config", "sync"],
    ["incidents", "list"],
    ["incidents", "show"],
    ["incidents", "acknowledge"],
    ["incidents", "snooze"],
    ["incidents", "dismiss"],
    ["targets"],
    ["probe"],
    ["cloudflare", "configure"],
  ]
  for (const route of routes) {
    const declarations = help(route).split("\n").filter((line) => (
      /^\s+(?:-[a-z],\s+)?--[a-z]/.test(line)
    ))
    for (const declaration of declarations) {
      assert.match(declaration, /^\s+-[a-z],\s+--[a-z]/, route.join(" "))
    }
  }
})

test("CLI parser supports option forms, interleaving, and explicit documents", () => {
  const probe = parseCliArguments(["-jc3", "probe", "targets.json"])
  assert.equal(probe.command, "probe")
  assert.equal(probe.configPath, "targets.json")
  assert.equal(probe.options.concurrency, 3)
  assert.equal(probe.options.json, true)

  const validate = parseCliArguments([
    "--json",
    "config",
    "validate",
    "targets.json",
  ])
  assert.equal(validate.command, "config.validate")
  assert.equal(validate.configPath, "targets.json")

  const targets = parseCliArguments([
    "-jp/private/profile.json",
    "targets",
  ])
  assert.equal(targets.options.json, true)
  assert.equal(targets.options.profilePath, "/private/profile.json")
  assert.equal(
    parseCliArguments(["targets", "targets.json"]).configPath,
    "targets.json",
  )
  assert.equal(
    parseCliArguments(["probe", "--", "-targets.json"]).configPath,
    "-targets.json",
  )

  const cloudflare = parseCliArguments([
    "cloudflare",
    "configure",
    "--config=targets.json",
  ])
  assert.equal(cloudflare.command, "cloudflare.configure")
  assert.deepEqual(cloudflare.commandArguments, ["--config=targets.json"])

  const incidents = parseCliArguments([
    "-ajp/private/profile.json",
    "-l5",
    "incidents",
    "list",
  ])
  assert.equal(incidents.command, "incidents.list")
  assert.equal(incidents.options.all, true)
  assert.equal(incidents.options.json, true)
  assert.equal(incidents.options.limit, 5)
  assert.equal(incidents.options.profilePath, "/private/profile.json")

  const snooze = parseCliArguments([
    "incidents",
    "snooze",
    "incident-one",
    "--until=2026-08-28T03:00:00Z",
    "--note",
    "Maintenance",
  ])
  assert.equal(snooze.command, "incidents.snooze")
  assert.equal(snooze.options.note, "Maintenance")
  assert.equal(snooze.options.until, "2026-08-28T03:00:00Z")

  const bootstrap = parseCliArguments([
    "cloudflare",
    "bootstrap",
    "--dry-run",
  ])
  assert.equal(bootstrap.command, "cloudflare.bootstrap")
  assert.deepEqual(bootstrap.commandArguments, ["--dry-run"])
  assert.equal(parseCliArguments(["init"]).command, "init")
  assert.equal(parseCliArguments(["deploy"]).command, "deploy")
})

test("CLI rejects removed commands, unknown routes, and command-specific options", async () => {
  const cases = [
    [],
    ["validate", "targets.json"],
    ["normalize", "targets.json"],
    ["targets", "path", "extra"],
    ["config"],
    ["incidents"],
    ["incidents", "missing"],
    ["incidents", "show"],
    ["incidents", "list", "--limit=101"],
    ["incidents", "snooze", "incident-one"],
    ["config", "missing"],
    ["config", "path", "extra"],
    ["config", "show", "--json", "targets.json"],
    ["config", "validate", "--profile", PROFILE_PATH, "targets.json"],
    ["targets", "--profile", PROFILE_PATH, "targets.json"],
    ["config", "sync", "-c2"],
    ["probe", "--concurrency=0", "targets.json"],
    ["probe", "--concurrency="],
    ["targets", "--profile="],
    ["targets", "--unknown"],
    ["cloudflare"],
    ["cloudflare", "missing"],
    ["help", "targets", "extra"],
    ["help", "missing"],
  ]
  for (const argv of cases) {
    const result = await commandOutput(argv)
    assert.equal(result.status, 2, argv.join(" "))
    assert.match(result.stderr, /^endpoint-monitor:/)
    assert.equal(result.stdout, "")
  }
})

test("config path resolves the active target document", async () => {
  const text = await commandOutput(["config", "path", "-p", PROFILE_PATH])
  assert.equal(text.status, 0)
  assert.equal(text.stdout, `${CONFIG_PATH}\n`)
  assert.equal(text.stderr, "")

  const json = await commandOutput([
    "-jp/private/endpoint-monitor.local.json",
    "config",
    "path",
  ])
  assert.equal(json.status, 0)
  assert.deepEqual(JSON.parse(json.stdout), { configPath: CONFIG_PATH })
})

test("config show and validate support active and explicit target documents", async () => {
  const active = await commandOutput(["config", "show", "-p", PROFILE_PATH])
  assert.equal(active.status, 0)
  const shown = JSON.parse(active.stdout)
  assert.equal(shown.targets[0].method, "GET")
  assert.equal(shown.targets[0].failureThreshold, 2)

  const explicit = await commandOutput([
    "config",
    "validate",
    "--json",
    "targets.json",
  ], {
    lstatImpl: async () => {
      throw new Error("explicit documents do not require private permissions")
    },
  })
  assert.equal(explicit.status, 0)
  assert.deepEqual(JSON.parse(explicit.stdout), { targetCount: 1, valid: true })

  const text = await commandOutput([
    "config",
    "validate",
    "-p",
    PROFILE_PATH,
  ])
  assert.equal(text.status, 0)
  assert.equal(text.stdout, "Valid target document with 1 target(s)\n")
})

test("targets lists the active document in text and JSON", async () => {
  const text = await commandOutput(["targets", "--profile", PROFILE_PATH])
  assert.equal(text.status, 0)
  assert.match(text.stdout, /example-home\tGET\t<500\t-\thttps:\/\/example\.com\//)
  assert.match(text.stdout, /1 target\(s\)/)

  const json = await commandOutput(["targets", "-jp", PROFILE_PATH])
  assert.equal(json.status, 0)
  const output = JSON.parse(json.stdout)
  assert.equal(output.configPath, CONFIG_PATH)
  assert.equal(output.targets[0].id, "example-home")
  assert.equal(output.targets[0].expect, null)
  assert.equal(output.targets[0].expectedStatuses, null)

  const explicit = await commandOutput(["targets", "--json", "targets.json"])
  assert.equal(explicit.status, 0)
  assert.equal(
    JSON.parse(explicit.stdout).configPath,
    path.resolve("targets.json"),
  )

  const validatedConfiguration = JSON.stringify({
    schemaVersion: 2,
    targets: [{
      expect: {
        bodyIncludes: "ready",
        contentType: "application/json",
        jsonSubset: { ok: true },
        location: { url: "https://www.example.com/" },
      },
      expectedStatuses: [301],
      id: "validated",
      url: "https://example.com/",
    }],
  })
  const validated = await commandOutput(["targets", "-p", PROFILE_PATH], {
    readFileImpl: async (filename) => filename === PROFILE_PATH
      ? PROFILE
      : filename === CONFIG_PATH
        ? validatedConfiguration
        : WRANGLER,
  })
  assert.match(
    validated.stdout,
    /body,content-type,json-subset,location/,
  )
})

test("probe uses the active document, supports explicit documents, and reports failures", async () => {
  const active = await commandOutput(["probe", "-p", PROFILE_PATH])
  assert.equal(active.status, 0)
  assert.match(active.stdout, /^OK example-home HTTP 200/m)

  const explicit = await commandOutput(["probe", "--json", "targets.json"])
  assert.equal(explicit.status, 0)
  assert.equal(JSON.parse(explicit.stdout).summary.succeeded, 1)

  const failure = await commandOutput([
    "probe",
    "-jp",
    PROFILE_PATH,
  ], {
    fetchImpl: async () => new Response(null, { status: 526 }),
  })
  assert.equal(failure.status, 1)
  assert.equal(JSON.parse(failure.stdout).results[0].httpStatus, 526)

  const validationFailure = await commandOutput([
    "probe",
    "targets.json",
  ], {
    fetchImpl: async () => new Response("not ready", { status: 200 }),
    readFileImpl: async () => JSON.stringify({
      schemaVersion: 2,
      targets: [{
        expect: { bodyIncludes: "service ready" },
        expectedStatuses: [200],
        id: "validated",
        url: "https://example.com/",
      }],
    }),
  })
  assert.equal(validationFailure.status, 1)
  assert.match(
    validationFailure.stdout,
    /FAIL validated HTTP 200 \(body-marker-missing\)/,
  )

  const runtime = await commandOutput(["probe", "targets.json"], {
    clock: () => Number.NaN,
  })
  assert.equal(runtime.status, 1)
  assert.equal(runtime.stderr, "endpoint-monitor: Probe execution failed\n")
})

test("config sync uses the profile binding and reviewed D1 authority", async (context) => {
  let request
  const db = d1Fixture(context)
  const fetchImpl = d1ApiFetch(db, (url, init) => { request = { init, url } })
  const result = await commandOutput([
    "config",
    "sync",
    ...INITIAL_REVIEW,
    "-jp",
    PROFILE_PATH,
  ], {
    environment: {
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: "api-token",
    },
    fetchImpl,
  })
  assert.equal(result.status, 0)
  const output = JSON.parse(result.stdout)
  assert.ok(output.rowsWritten > 0)
  assert.equal(output.revision, 1)
  assert.equal(output.targetCount, 1)
  assert.match(output.configFingerprint, /^sha256:[a-f0-9]{64}$/)
  assert.equal(String(request.url).includes(DATABASE_ID), true)
  assert.equal(JSON.parse(request.init.body).params[4], "2026-08-27T03:00:00.000Z")

  const text = await commandOutput([
    "config",
    "sync",
    "-r1",
    `-f${LOADED.configFingerprint}`,
    "-p",
    PROFILE_PATH,
  ], {
    environment: {
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: "api-token",
    },
    fetchImpl,
  })
  assert.equal(text.status, 0)
  assert.equal(text.stdout, "Synchronized 1 target(s) at revision 1; D1 rows written: 0\n")
})

test("config review, remote export, and sync share one guarded authority", async (context) => {
  const db = d1Fixture(context)
  const overrides = {
    environment: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, CLOUDFLARE_API_TOKEN: "api-token" },
    fetchImpl: d1ApiFetch(db),
  }
  const review = await commandOutput(["config", "review", "-jp", PROFILE_PATH], overrides)
  assert.equal(review.status, 0, review.stderr)
  assert.equal(JSON.parse(review.stdout).expectedRevision, 0)
  assert.equal(JSON.parse(review.stdout).expectedFingerprint, LOADED.configFingerprint)
  const text = await commandOutput(["config", "review", "-p", PROFILE_PATH], overrides)
  assert.match(text.stdout, /Remote revision: 0/)
  const absent = await commandOutput(["config", "remote", "-p", PROFILE_PATH], overrides)
  assert.equal(absent.status, 1)
  assert.equal(absent.stdout, "")
  const synced = await commandOutput(["config", "sync", ...INITIAL_REVIEW, "-p", PROFILE_PATH], overrides)
  assert.equal(synced.status, 0, synced.stderr)
  const exported = await commandOutput(["config", "remote", "-p", PROFILE_PATH], {
    ...overrides,
    readFileImpl: async (filename) => {
      assert.notEqual(filename, CONFIG_PATH)
      return filename === PROFILE_PATH ? PROFILE : WRANGLER
    },
  })
  assert.equal(exported.status, 0, exported.stderr)
  assert.deepEqual(JSON.parse(exported.stdout), LOADED.portable)
  const stale = await commandOutput(["config", "sync", ...INITIAL_REVIEW, "-p", PROFILE_PATH], overrides)
  assert.equal(stale.status, 1)
  assert.match(stale.stderr, /Remote configuration changed/)
  const changed = await commandOutput(["config", "sync", "-r1", "-f" + LOADED.configFingerprint, "-p", PROFILE_PATH], {
    ...overrides,
    readFileImpl: async (filename) => filename === CONFIG_PATH
      ? JSON.stringify({ schemaVersion: 1, targets: [] })
      : filename === PROFILE_PATH ? PROFILE : WRANGLER,
  })
  assert.equal(changed.status, 2)
  assert.match(changed.stderr, /candidate changed since review/)
  assert.equal(db.sqlite.prepare("SELECT revision FROM monitor_configuration").get().revision, 1)
})

test("configuration review flags reject missing, invalid, and unrelated uses before network access", async () => {
  for (const argumentsList of [
    ["config", "sync"],
    ["config", "sync", "-r0"],
    ["config", "sync", "--expect-revision=-1", "-f" + LOADED.configFingerprint],
    ["config", "sync", "-r1.2", "-f" + LOADED.configFingerprint],
    ["config", "sync", "-r0", "-fbad"],
    ["config", "review", ...INITIAL_REVIEW],
    ["config", "remote", "--json"],
  ]) {
    const result = await commandOutput(argumentsList, { fetchImpl: () => assert.fail("No network access") })
    assert.equal(result.status, 2, argumentsList.join(" "))
    assert.equal(result.stdout, "")
  }
})

test("CLI reports target, profile, Wrangler, and provider preconditions distinctly", async () => {
  const unreadable = await commandOutput([
    "config",
    "validate",
    "missing.json",
  ], {
    readFileImpl: async () => {
      throw new Error("private detail")
    },
  })
  assert.equal(unreadable.status, 2)
  assert.match(unreadable.stderr, /Cannot read target document/)
  assert.equal(unreadable.stderr.includes("private detail"), false)

  const invalidJson = await commandOutput([
    "config",
    "validate",
    "targets.json",
  ], {
    readFileImpl: async () => "not-json",
  })
  assert.equal(invalidJson.status, 2)
  assert.match(invalidJson.stderr, /Target document is not valid JSON/)

  const invalidDocument = await commandOutput([
    "config",
    "validate",
    "targets.json",
  ], {
    readFileImpl: async () => '{"schemaVersion":3,"targets":[]}',
  })
  assert.equal(invalidDocument.status, 2)
  assert.match(invalidDocument.stderr, /schemaVersion/)

  const unsafeProfile = await commandOutput([
    "config",
    "path",
    "-p",
    PROFILE_PATH,
  ], {
    lstatImpl: async () => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      mode: 0o100644,
    }),
  })
  assert.equal(unsafeProfile.status, 2)
  assert.match(unsafeProfile.stderr, /Operator profile must be a mode-0600 regular file/)

  const unsafeTarget = await commandOutput([
    "targets",
    "-p",
    PROFILE_PATH,
  ], {
    lstatImpl: async (filename) => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      mode: filename === CONFIG_PATH ? 0o100644 : 0o100600,
    }),
  })
  assert.equal(unsafeTarget.status, 2)
  assert.match(unsafeTarget.stderr, /Target document must be a mode-0600 regular file/)

  const invalidProfile = await commandOutput([
    "config",
    "path",
    "-p",
    PROFILE_PATH,
  ], {
    readFileImpl: async () => JSON.stringify({ schemaVersion: 1 }),
  })
  assert.equal(invalidProfile.status, 2)
  assert.match(invalidProfile.stderr, /Operator profile is invalid/)

  const missingAccount = await commandOutput([
    "config",
    "sync",
    ...INITIAL_REVIEW,
    "-p",
    PROFILE_PATH,
  ])
  assert.equal(missingAccount.status, 2)
  assert.match(missingAccount.stderr, /CLOUDFLARE_ACCOUNT_ID/)

  const missingToken = await commandOutput([
    "config",
    "sync",
    ...INITIAL_REVIEW,
    "-p",
    PROFILE_PATH,
  ], {
    environment: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
  })
  assert.equal(missingToken.status, 2)
  assert.match(missingToken.stderr, /CLOUDFLARE_API_TOKEN/)

  const invalidWrangler = await commandOutput([
    "config",
    "sync",
    ...INITIAL_REVIEW,
    "-p",
    PROFILE_PATH,
  ], {
    environment: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
    readFileImpl: async (filename) => filename === PROFILE_PATH
      ? PROFILE
      : filename === CONFIG_PATH
        ? CONFIGURATION
        : "{}",
  })
  assert.equal(invalidWrangler.status, 2)
  assert.match(invalidWrangler.stderr, /MONITOR_DB/)

  const unsafeWrangler = await commandOutput([
    "config",
    "sync",
    ...INITIAL_REVIEW,
    "-p",
    PROFILE_PATH,
  ], {
    environment: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
    lstatImpl: async (filename) => ({
      isFile: () => true,
      isSymbolicLink: () => filename === WRANGLER_PATH,
      mode: 0o100600,
    }),
  })
  assert.equal(unsafeWrangler.status, 2)
  assert.match(unsafeWrangler.stderr, /Wrangler configuration must be a mode-0600 regular file/)
})

test("cloudflare configure dispatches through the unified command", async () => {
  const result = await commandOutput([
    "cloudflare",
    "configure",
    "--config",
    "targets.json",
    "--database-id",
    DATABASE_ID,
    "--dry-run",
  ])
  assert.equal(result.status, 0)
  assert.equal(result.stderr, "")
  const plan = JSON.parse(result.stdout)
  assert.equal(plan.dryRun, true)
  assert.equal(plan.targetCount, 1)

  const invalid = await commandOutput(["cloudflare", "configure"])
  assert.equal(invalid.status, 2)
  assert.match(invalid.stderr, /^endpoint-monitor:/)
})

test("CLI executes when its entrypoint is reached through a filesystem alias", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "endpoint-monitor-cli-"))
  context.after(() => rm(directory, { force: true, recursive: true }))
  const entrypoint = fileURLToPath(new URL("../src/cli.mjs", import.meta.url))
  const alias = path.join(directory, "endpoint-monitor.mjs")
  const configuration = path.join(directory, "targets.json")
  await symlink(entrypoint, alias)
  await writeFile(configuration, CONFIGURATION)

  const result = spawnSync(
    process.execPath,
    [alias, "config", "validate", "--json", configuration],
    { encoding: "utf8" },
  )

  assert.equal(result.status, 0)
  assert.equal(result.stderr, "")
  assert.deepEqual(JSON.parse(result.stdout), { targetCount: 1, valid: true })
})
