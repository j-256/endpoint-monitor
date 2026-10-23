import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import {
  COMMAND,
  EXIT,
  PACKAGE_FILES,
  ReleaseError,
  main,
  parseArguments,
  parsePackOutput,
  prepareRelease,
  usage,
  validateArchiveFiles,
  validateReleaseMetadata,
} from "../scripts/release.mjs"

const VERSION = "0.1.0"
const PACKAGE_NAME = "@j-256/endpoint-monitor"
const EMPTY_ENVIRONMENT = Object.freeze({})
const execFile = promisify(execFileCallback)

function packageMetadata(overrides = {}) {
  return {
    files: [...PACKAGE_FILES],
    name: PACKAGE_NAME,
    private: true,
    version: VERSION,
    ...overrides,
  }
}

function lockMetadata(overrides = {}) {
  return {
    name: PACKAGE_NAME,
    packages: {
      "": {
        name: PACKAGE_NAME,
        version: VERSION,
      },
    },
    version: VERSION,
    ...overrides,
  }
}

function requiredArchiveFiles() {
  return [
    "CHANGELOG.md",
    "LICENSE",
    "README.md",
    "docs/architecture.md",
    "docs/cloudflare.md",
    "docs/management.md",
    "docs/releases.md",
    "endpoint-monitor.example.json",
    "migrations/0001_initial.sql",
    "migrations/0002_incident_triage.sql",
    "migrations/0003_configuration_authority.sql",
    "migrations/0004_management.sql",
    "package.json",
    "scripts/configure-cloudflare.mjs",
    "src/adapters/cloudflare/deployment.mjs",
    "src/adapters/cloudflare/worker.mjs",
    "src/cli.mjs",
    "src/core.mjs",
    "src/project.mjs",
    "wrangler.example.jsonc",
    "watchdog/README.md",
    "watchdog/config.example.json",
    "watchdog/endpoint_monitor_watchdog.py",
  ].map((path) => ({ path }))
}

function streamFixture() {
  let output = ""
  return {
    read: () => output,
    write: (value) => {
      output += value
    },
  }
}

test("release parser supports commands, tag forms, interleaving, and help", () => {
  assert.deepEqual(parseArguments(["prepare", "--tag=v0.2.0"], EMPTY_ENVIRONMENT), {
    command: "prepare", tag: "v0.2.0",
  })
  assert.deepEqual(parseArguments(["check"], EMPTY_ENVIRONMENT), {
    command: COMMAND.CHECK,
    tag: null,
  })
  assert.deepEqual(parseArguments(["--", "check"], EMPTY_ENVIRONMENT), {
    command: COMMAND.CHECK,
    tag: null,
  })
  assert.deepEqual(parseArguments(["-tv0.1.0", "build"], EMPTY_ENVIRONMENT), {
    command: COMMAND.BUILD,
    tag: "v0.1.0",
  })
  assert.deepEqual(parseArguments(["build", "--tag=v0.1.0"], EMPTY_ENVIRONMENT), {
    command: COMMAND.BUILD,
    tag: "v0.1.0",
  })
  assert.deepEqual(parseArguments(["--tag", "v0.1.0", "build"], EMPTY_ENVIRONMENT), {
    command: COMMAND.BUILD,
    tag: "v0.1.0",
  })
  assert.deepEqual(
    parseArguments(["check"], {
      GITHUB_REF_NAME: "v0.1.0",
      GITHUB_REF_TYPE: "tag",
    }),
    { command: COMMAND.CHECK, tag: "v0.1.0" },
  )
  assert.equal(parseArguments(["--help"], EMPTY_ENVIRONMENT).command, COMMAND.HELP)
  assert.equal(parseArguments(["-h"], EMPTY_ENVIRONMENT).command, COMMAND.HELP)
})

test("release parser rejects missing, unknown, extra, and conflicting values", () => {
  for (const argv of [[], ["publish"], ["check", "extra"], ["--unknown"], ["--tag="], ["prepare"],
    ["prepare", "--tag=v0.2.0-beta"], ["prepare", "--tag=v01.2.0"]]) {
    assert.throws(() => parseArguments(argv, EMPTY_ENVIRONMENT), ReleaseError)
  }
  assert.throws(
    () => parseArguments(["check", "--tag", "v0.1.0"], {
      GITHUB_REF_NAME: "v0.2.0",
      GITHUB_REF_TYPE: "tag",
    }),
    /does not match/,
  )
})

test("release metadata binds package, lockfile, changelog, and tag", () => {
  const changelog = `# Changelog\n\n## [${VERSION}] - 2026-08-27\n`
  assert.deepEqual(
    validateReleaseMetadata(
      packageMetadata(),
      lockMetadata(),
      changelog,
      `v${VERSION}`,
    ),
    [],
  )
  assert.match(
    validateReleaseMetadata(
      packageMetadata({ private: false, version: "invalid" }),
      lockMetadata(),
      "# Changelog\n",
      "v9.9.9",
    ).join("\n"),
    /semantic.*private.*package-lock.*CHANGELOG.*release tag/s,
  )
})

test("release archive validation accepts only the runtime allowlist", () => {
  assert.deepEqual(validateArchiveFiles(requiredArchiveFiles()), [])
  const issues = validateArchiveFiles([
    ...requiredArchiveFiles().filter((entry) => entry.path !== "src/core.mjs"),
    { path: "test/core.test.mjs" },
  ])
  assert.match(issues.join("\n"), /missing src\/core\.mjs/)
  assert.match(issues.join("\n"), /unexpected test\/core\.test\.mjs/)
})

test("release pack output requires one JSON package result", () => {
  const result = parsePackOutput(JSON.stringify([{ filename: "package.tgz", files: [] }]))
  assert.equal(result.filename, "package.tgz")
  assert.throws(() => parsePackOutput("invalid"), /invalid JSON/)
  assert.throws(() => parsePackOutput("[]"), /unexpected result/)
})

test("release command help documents non-mutating and build behavior", async () => {
  assert.match(usage(), /No command publishes, tags, pushes, or deploys/)
  assert.match(usage(), /SHA256SUMS/)
  const stdout = streamFixture()
  const stderr = streamFixture()
  assert.equal(await main(["--help"], { stderr, stdout }), EXIT.SUCCESS)
  assert.match(stdout.read(), /^Usage:/)
  assert.equal(stderr.read(), "")

  const invalidStdout = streamFixture()
  const invalidStderr = streamFixture()
  assert.equal(
    await main(["publish"], {
      stderr: invalidStderr,
      stdout: invalidStdout,
    }),
    EXIT.USAGE,
  )
  assert.equal(invalidStdout.read(), "")
  assert.match(invalidStderr.read(), /^release: Unknown command/)
})

async function preparationFixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "endpoint-monitor-version-"))
  context.after(() => rm(root, { recursive: true, force: true }))
  const git = (args) => execFile("git", args, { cwd: root, encoding: "utf8" })
  const changelog = `# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Synthetic feature\n\n## [0.1.0] - 2026-08-27\n\n- Initial release\n\n[Unreleased]: https://github.com/j-256/endpoint-monitor/compare/v0.1.0...HEAD\n[0.1.0]: https://github.com/j-256/endpoint-monitor/releases/tag/v0.1.0\n`
  await writeFile(path.join(root, "package.json"), JSON.stringify(packageMetadata()))
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, ...lockMetadata() }))
  await writeFile(path.join(root, "CHANGELOG.md"), changelog)
  await git(["init", "-b", "main"])
  await git(["add", "package.json", "package-lock.json", "CHANGELOG.md"])
  await git(["-c", "user.name=Release Test", "-c", "user.email=release@example.com", "commit", "-m", "Initial fixture"])
  const readFiles = () => Promise.all(["package.json", "package-lock.json", "CHANGELOG.md"]
    .map((filename) => readFile(path.join(root, filename), "utf8")))
  let checks = 0
  const options = { projectRoot: root, clock: () => Date.parse("2026-10-23T18:00:00Z"),
    runCommand: async (command, args, { cwd }) => {
      if (command === "npm" && args.join(" ") === "run check") { checks += 1; return { stdout: "" } }
      return execFile(command, args, { cwd, encoding: "utf8" })
    } }
  return { root, git, options, readFiles, checkCount: () => checks }
}

test("version preparation runs checks before using npm metadata updates and preserves empty Unreleased", async (context) => {
  const fixture = await preparationFixture(context)
  const result = await prepareRelease("v0.2.0", fixture.options)
  const [packageSource, lockSource, changelog] = await fixture.readFiles()
  assert.equal(result.version, "0.2.0")
  assert.equal(fixture.checkCount(), 1)
  assert.equal(JSON.parse(packageSource).version, "0.2.0")
  assert.equal(JSON.parse(packageSource).private, true)
  assert.equal(JSON.parse(lockSource).version, "0.2.0")
  assert.equal(JSON.parse(lockSource).packages[""].version, "0.2.0")
  assert.match(changelog, /## \[Unreleased\]\n\n## \[0\.2\.0\] - 2026-10-23\n\n### Added\n\n- Synthetic feature/)
  assert.match(changelog, /\[Unreleased\]: https:\/\/github.com\/j-256\/endpoint-monitor\/compare\/v0.2.0\.\.\.HEAD/)
  assert.match(changelog, /\[0.2.0\]: https:\/\/github.com\/j-256\/endpoint-monitor\/compare\/v0.1.0\.\.\.v0.2.0/)
  assert.equal((await fixture.git(["tag", "--list"])).stdout, "")
  assert.equal((await fixture.git(["rev-list", "--count", "HEAD"])).stdout.trim(), "1")
})

test("version preparation rejects branch, dirty, tag and version preconditions without changing files", async (context) => {
  for (const scenario of ["branch", "dirty", "untracked", "tag", "same", "older", "missing-tag", "prerelease"]) {
    const fixture = await preparationFixture(context)
    if (scenario === "branch") await fixture.git(["checkout", "-b", "topic"])
    if (scenario === "dirty") await writeFile(path.join(fixture.root, "package.json"), JSON.stringify(packageMetadata({ description: "Pending edit" })))
    if (scenario === "untracked") await writeFile(path.join(fixture.root, "pending.txt"), "Pending edit")
    if (scenario === "tag") await fixture.git(["tag", "v0.2.0"])
    const before = await fixture.readFiles()
    const tag = { same: "v0.1.0", older: "v0.0.1", "missing-tag": null, prerelease: "v0.2.0-beta" }[scenario] ?? (scenario === "missing-tag" ? null : "v0.2.0")
    await assert.rejects(prepareRelease(tag, fixture.options), ReleaseError, scenario)
    assert.deepEqual(await fixture.readFiles(), before, scenario)
    assert.equal(fixture.checkCount(), 0, scenario)
  }
})

test("failed or dirtying release checks leave version metadata untouched", async (context) => {
  for (const scenario of ["failure", "dirty", "branch", "head", "tag"]) {
    const fixture = await preparationFixture(context)
    const before = await fixture.readFiles()
    const runCommand = fixture.options.runCommand
    fixture.options.runCommand = async (command, args, options) => {
      if (command === "npm" && args.join(" ") === "run check") {
        if (scenario === "failure") throw new Error("Synthetic check failure")
        if (scenario === "dirty") await writeFile(path.join(fixture.root, "pending.txt"), "Pending edit")
        if (scenario === "branch") await fixture.git(["checkout", "-b", "topic"])
        if (scenario === "head") await fixture.git(["-c", "user.name=Release Test", "-c", "user.email=release@example.com", "commit", "--allow-empty", "-m", "Concurrent commit"])
        if (scenario === "tag") await fixture.git(["tag", "v0.2.0"])
        return { stdout: "" }
      }
      return runCommand(command, args, options)
    }
    await assert.rejects(prepareRelease("v0.2.0", fixture.options), scenario === "failure" ? /Synthetic check failure/ : ReleaseError)
    assert.deepEqual(await fixture.readFiles(), before, scenario)
  }
})

test("malformed release notes are rejected before checks or version changes", async (context) => {
  for (const scenario of ["empty", "missing-link", "duplicate-heading"]) {
    const fixture = await preparationFixture(context)
    const filename = path.join(fixture.root, "CHANGELOG.md")
    let changelog = await readFile(filename, "utf8")
    if (scenario === "empty") changelog = changelog.replace("### Added\n\n- Synthetic feature\n\n", "")
    if (scenario === "missing-link") changelog = changelog.replace("[Unreleased]: https://github.com/j-256/endpoint-monitor/compare/v0.1.0...HEAD", "")
    if (scenario === "duplicate-heading") changelog = changelog.replace("## [0.1.0]", "## [Unreleased]\n\n## [0.1.0]")
    await writeFile(filename, changelog)
    await fixture.git(["add", "CHANGELOG.md"])
    await fixture.git(["-c", "user.name=Release Test", "-c", "user.email=release@example.com", "commit", "-m", "Malformed fixture"])
    const before = await fixture.readFiles()
    await assert.rejects(prepareRelease("v0.2.0", fixture.options), ReleaseError, scenario)
    assert.deepEqual(await fixture.readFiles(), before, scenario)
    assert.equal(fixture.checkCount(), 0, scenario)
  }
})
