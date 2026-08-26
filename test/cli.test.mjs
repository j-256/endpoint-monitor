import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  help,
  parseCliArguments,
  runCli,
} from "../src/cli.mjs"

const CONFIGURATION = JSON.stringify({
  defaults: { probeIntervalMinutes: 5 },
  schemaVersion: 1,
  targets: [{ id: "example-home", url: "https://example.com/" }],
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
    clock: () => Date.parse("2026-08-26T03:00:00.000Z"),
    fetchImpl: async () => new Response(null, { status: 200 }),
    readFileImpl: async () => CONFIGURATION,
    stderr: streamFixture(),
    stdout: streamFixture(),
    ...overrides,
  }
}

test("CLI help documents commands, configuration, and exit statuses", async () => {
  assert.match(help(), /validate/)
  assert.match(help(), /schemaVersion 1/)
  assert.match(help("probe"), /Exit status/)
  for (const argv of [["--help"], ["-h"], ["probe", "--help"], ["help", "probe"]]) {
    const deps = dependencies()
    assert.equal(await runCli(argv, deps), 0)
    assert.match(deps.stdout.read(), /Usage:/)
    assert.equal(deps.stderr.read(), "")
  }
})

test("CLI parser supports long values, glued short values, bundles, and interleaving", () => {
  assert.deepEqual(
    parseCliArguments(["-jc3", "probe", "targets.json"]),
    {
      command: "probe",
      configPath: "targets.json",
      help: false,
      options: { concurrency: 3, help: false, json: true },
    },
  )
  assert.equal(
    parseCliArguments(["probe", "--concurrency=4", "targets.json"]).options.concurrency,
    4,
  )
  assert.equal(
    parseCliArguments(["--json", "probe", "targets.json", "-c", "2"]).options.concurrency,
    2,
  )
  assert.equal(
    parseCliArguments(["probe", "--", "-targets.json"]).configPath,
    "-targets.json",
  )
})

test("CLI rejects unknown, missing, empty, and command-specific options", async () => {
  const cases = [
    [],
    ["unknown", "targets.json"],
    ["probe"],
    ["probe", "--unknown", "targets.json"],
    ["probe", "--concurrency=", "targets.json"],
    ["probe", "-c0", "targets.json"],
    ["validate", "-c2", "targets.json"],
    ["normalize", "--json", "targets.json"],
  ]
  for (const argv of cases) {
    const deps = dependencies()
    assert.equal(await runCli(argv, deps), 2)
    assert.match(deps.stderr.read(), /^endpoint-monitor:/)
    assert.equal(deps.stdout.read(), "")
  }
})

test("validate and normalize do not require network access", async () => {
  const validate = dependencies({
    fetchImpl: async () => {
      throw new Error("network must not run")
    },
  })
  assert.equal(await runCli(["validate", "--json", "targets.json"], validate), 0)
  assert.deepEqual(JSON.parse(validate.stdout.read()), { targetCount: 1, valid: true })

  const normalize = dependencies()
  assert.equal(await runCli(["normalize", "targets.json"], normalize), 0)
  const output = JSON.parse(normalize.stdout.read())
  assert.equal(output.targets[0].method, "GET")
  assert.equal(output.targets[0].failureThreshold, 2)
})

test("probe reports result data and uses failure as its exit status", async () => {
  const success = dependencies()
  assert.equal(await runCli(["probe", "targets.json"], success), 0)
  assert.match(success.stdout.read(), /^OK example-home HTTP 200/m)
  assert.equal(success.stderr.read(), "")

  const failure = dependencies({
    fetchImpl: async () => new Response(null, { status: 526 }),
  })
  assert.equal(await runCli(["probe", "-j", "targets.json"], failure), 1)
  const output = JSON.parse(failure.stdout.read())
  assert.equal(output.summary.failed, 1)
  assert.equal(output.results[0].httpStatus, 526)
})

test("CLI separates file, JSON, configuration, and runtime diagnostics", async () => {
  const unreadable = dependencies({
    readFileImpl: async () => {
      throw new Error("private detail")
    },
  })
  assert.equal(await runCli(["validate", "private.json"], unreadable), 2)
  assert.match(unreadable.stderr.read(), /Cannot read configuration/)
  assert.equal(unreadable.stderr.read().includes("private detail"), false)

  const json = dependencies({ readFileImpl: async () => "not-json" })
  assert.equal(await runCli(["validate", "targets.json"], json), 2)
  assert.match(json.stderr.read(), /not valid JSON/)

  const invalid = dependencies({
    readFileImpl: async () => '{"schemaVersion":2,"targets":[]}',
  })
  assert.equal(await runCli(["validate", "targets.json"], invalid), 2)
  assert.match(invalid.stderr.read(), /schemaVersion/)

  const runtime = dependencies({
    clock: () => Number.NaN,
  })
  assert.equal(await runCli(["probe", "targets.json"], runtime), 1)
  assert.equal(runtime.stderr.read(), "endpoint-monitor: Probe execution failed\n")
})

test("CLI executes when its entrypoint is reached through a filesystem alias", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "endpoint-monitor-cli-"))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const entrypoint = fileURLToPath(new URL("../src/cli.mjs", import.meta.url))
  const alias = path.join(directory, "endpoint-monitor.mjs")
  const configuration = path.join(directory, "targets.json")
  await symlink(entrypoint, alias)
  await writeFile(configuration, CONFIGURATION)

  const result = spawnSync(
    process.execPath,
    [alias, "validate", "--json", configuration],
    { encoding: "utf8" },
  )

  assert.equal(result.status, 0)
  assert.equal(result.stderr, "")
  assert.deepEqual(JSON.parse(result.stdout), { targetCount: 1, valid: true })
})
