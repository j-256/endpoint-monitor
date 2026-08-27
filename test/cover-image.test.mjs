import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import {
  CoverError,
  EXIT,
  MODE,
  main,
  parseArguments,
  usage,
  validateCoverSource,
  verifyBrowserExecutable,
} from "../scripts/capture-cover.mjs"
import {
  COVER_HEIGHT,
  COVER_WIDTH,
  coverDimensions,
  validateCoverImage,
} from "../scripts/cover-image.mjs"

function png(width = COVER_WIDTH, height = COVER_HEIGHT) {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
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

test("cover image validation enforces PNG format and portfolio dimensions", () => {
  assert.deepEqual(coverDimensions(png()), {
    height: COVER_HEIGHT,
    width: COVER_WIDTH,
  })
  assert.deepEqual(validateCoverImage(png()), {
    height: COVER_HEIGHT,
    width: COVER_WIDTH,
  })
  assert.throws(() => coverDimensions(new Uint8Array(24)), /PNG/)
  assert.throws(() => validateCoverImage(png(1280, 720)), /1440x1000/)
})

test("cover parser supports checks, output forms, bundles, and help", () => {
  assert.equal(parseArguments(["--"]).mode, MODE.CAPTURE)
  assert.equal(parseArguments(["--check"]).mode, MODE.CHECK)
  assert.equal(parseArguments(["-c"]).mode, MODE.CHECK)
  assert.equal(
    parseArguments(["-o", "cover.png"]).outputPath,
    path.resolve("cover.png"),
  )
  assert.equal(
    parseArguments(["--output=cover.png"]).outputPath,
    path.resolve("cover.png"),
  )
  assert.equal(parseArguments(["-hoignored.png"]).mode, MODE.HELP)
  assert.equal(parseArguments(["--help"]).mode, MODE.HELP)
})

test("cover parser rejects unknown, positional, empty, and conflicting options", () => {
  for (const argv of [
    ["cover.png"],
    ["--unknown"],
    ["--output="],
    ["--check", "--output", "cover.png"],
    ["--", "--check"],
  ]) {
    assert.throws(() => parseArguments(argv), CoverError)
  }
})

test("cover source validation requires an offline synthetic static scene", () => {
  const source = "<main data-cover-root>SYNTHETIC OPERATOR RUN</main>"
  assert.equal(validateCoverSource(source), true)
  assert.throws(() => validateCoverSource("SYNTHETIC OPERATOR RUN"), /cover root/)
  assert.throws(
    () => validateCoverSource(`${source}<img src=\"https://example.com/x.png\">`),
    /network resources/,
  )
  assert.throws(() => validateCoverSource(`${source}<script></script>`), /scripts/)
})

test("cover command documents its interface and missing browser status", async () => {
  assert.match(usage(), /npm run capture:cover/)
  assert.match(usage(), /playwright install chromium/)
  assert.throws(
    () => verifyBrowserExecutable("/nonexistent/playwright-chromium"),
    (error) => error.exitCode === EXIT.MISSING_DEPENDENCY,
  )
  const stdout = streamFixture()
  const stderr = streamFixture()
  assert.equal(await main(["--help"], { stderr, stdout }), EXIT.SUCCESS)
  assert.match(stdout.read(), /^Usage:/)
  assert.equal(stderr.read(), "")

  const invalidStdout = streamFixture()
  const invalidStderr = streamFixture()
  assert.equal(
    await main(["--unknown"], {
      stderr: invalidStderr,
      stdout: invalidStdout,
    }),
    EXIT.USAGE,
  )
  assert.equal(invalidStdout.read(), "")
  assert.match(invalidStderr.read(), /^capture-cover: Unknown option/)
})
