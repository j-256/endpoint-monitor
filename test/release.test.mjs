import assert from "node:assert/strict"
import test from "node:test"

import {
  COMMAND,
  EXIT,
  PACKAGE_FILES,
  ReleaseError,
  main,
  parseArguments,
  parsePackOutput,
  usage,
  validateArchiveFiles,
  validateReleaseMetadata,
} from "../scripts/release.mjs"

const VERSION = "0.1.0"

function packageMetadata(overrides = {}) {
  return {
    files: [...PACKAGE_FILES],
    name: "endpoint-monitor",
    private: true,
    version: VERSION,
    ...overrides,
  }
}

function lockMetadata(overrides = {}) {
  return {
    name: "endpoint-monitor",
    packages: {
      "": {
        name: "endpoint-monitor",
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
    "endpoint-monitor.example.json",
    "migrations/0001_initial.sql",
    "package.json",
    "scripts/configure-cloudflare.mjs",
    "src/adapters/cloudflare/worker.mjs",
    "src/cli.mjs",
    "src/core.mjs",
    "wrangler.example.jsonc",
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
  assert.deepEqual(parseArguments(["check"]), { command: COMMAND.CHECK, tag: null })
  assert.deepEqual(parseArguments(["--", "check"]), {
    command: COMMAND.CHECK,
    tag: null,
  })
  assert.deepEqual(parseArguments(["-tv0.1.0", "build"]), {
    command: COMMAND.BUILD,
    tag: "v0.1.0",
  })
  assert.deepEqual(parseArguments(["build", "--tag=v0.1.0"]), {
    command: COMMAND.BUILD,
    tag: "v0.1.0",
  })
  assert.deepEqual(parseArguments(["--tag", "v0.1.0", "build"]), {
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
  assert.equal(parseArguments(["--help"]).command, COMMAND.HELP)
  assert.equal(parseArguments(["-h"]).command, COMMAND.HELP)
})

test("release parser rejects missing, unknown, extra, and conflicting values", () => {
  for (const argv of [[], ["publish"], ["check", "extra"], ["--unknown"], ["--tag="]]) {
    assert.throws(() => parseArguments(argv), ReleaseError)
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
  assert.match(usage(), /Neither command publishes, tags, pushes, or deploys/)
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
