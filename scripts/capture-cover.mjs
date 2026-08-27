#!/usr/bin/env node

import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { chromium } from "playwright"

import {
  COVER_HEIGHT,
  COVER_PATH,
  COVER_SOURCE_PATH,
  COVER_WIDTH,
  validateCoverImage,
} from "./cover-image.mjs"
import { isMainModule } from "../src/main-module.mjs"

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DEFAULT_OUTPUT_PATH = path.join(PROJECT_ROOT, COVER_PATH)
const SOURCE_PATH = path.join(PROJECT_ROOT, COVER_SOURCE_PATH)
const MODE = Object.freeze({
  CAPTURE: "capture",
  CHECK: "check",
  HELP: "help",
})
const EXIT = Object.freeze({
  MISSING_DEPENDENCY: 3,
  RUNTIME: 1,
  SUCCESS: 0,
  USAGE: 2,
})

class CoverError extends Error {
  constructor(message, exitCode = EXIT.USAGE) {
    super(message)
    this.exitCode = exitCode
  }
}

export function usage() {
  return `Usage: npm run capture:cover -- [options]

Render the tracked synthetic Endpoint Monitor scene in Playwright Chromium and
write a deterministic ${COVER_WIDTH}x${COVER_HEIGHT} PNG. With --check, validate
the committed HTML source and PNG without launching a browser.

Options:
  -c, --check          Validate the committed cover without rendering
  -o, --output <path>  Write the rendered PNG to a different path
  -h, --help           Show this help

Dependencies:
  Install packages with npm ci and Chromium with npx playwright install chromium.

Exit status:
  0  Capture or validation succeeded
  1  Rendering, validation, or file operation failed
  2  Command usage is invalid
  3  Playwright Chromium is unavailable
`
}

function optionValue(argv, index, attached, name) {
  if (attached !== null) {
    if (!attached) throw new CoverError(`${name} requires a value`)
    return { index, value: attached }
  }
  const value = argv[index + 1]
  if (value === undefined || value === "") {
    throw new CoverError(`${name} requires a value`)
  }
  return { index: index + 1, value }
}

export function parseArguments(argv) {
  let check = false
  let endOfOptions = false
  let help = false
  let outputPath = null
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (endOfOptions || argument === "-" || !argument.startsWith("-")) {
      throw new CoverError(`Unexpected argument: ${argument}`)
    }
    if (argument === "--") {
      endOfOptions = true
      continue
    }
    if (argument.startsWith("--")) {
      const equals = argument.indexOf("=")
      const name = equals === -1 ? argument : argument.slice(0, equals)
      const attached = equals === -1 ? null : argument.slice(equals + 1)
      if (name === "--check" || name === "--help") {
        if (attached !== null) throw new CoverError(`${name} does not take a value`)
        if (name === "--check") check = true
        else help = true
      } else if (name === "--output") {
        const parsed = optionValue(argv, index, attached, name)
        outputPath = parsed.value
        index = parsed.index
      } else {
        throw new CoverError(`Unknown option: ${name}`)
      }
      continue
    }
    let bundle = argument.slice(1)
    while (bundle) {
      const name = bundle[0]
      bundle = bundle.slice(1)
      if (name === "c" || name === "h") {
        if (name === "c") check = true
        else help = true
      } else if (name === "o") {
        const parsed = optionValue(argv, index, bundle || null, "-o")
        outputPath = parsed.value
        index = parsed.index
        bundle = ""
      } else {
        throw new CoverError(`Unknown option: -${name}`)
      }
    }
  }
  if (help) return Object.freeze({ mode: MODE.HELP, outputPath: null })
  if (check && outputPath) {
    throw new CoverError("--check cannot be combined with --output")
  }
  return Object.freeze({
    mode: check ? MODE.CHECK : MODE.CAPTURE,
    outputPath: outputPath ? path.resolve(outputPath) : DEFAULT_OUTPUT_PATH,
  })
}

export function validateCoverSource(source) {
  if (!source.includes("data-cover-root")) {
    throw new TypeError(`${COVER_SOURCE_PATH} is missing the cover root`)
  }
  if (!source.includes("SYNTHETIC OPERATOR RUN")) {
    throw new TypeError(`${COVER_SOURCE_PATH} must label its synthetic data`)
  }
  if (/\bhttps?:\/\//i.test(source)) {
    throw new TypeError(`${COVER_SOURCE_PATH} must not load network resources`)
  }
  if (/<script\b/i.test(source)) {
    throw new TypeError(`${COVER_SOURCE_PATH} must not execute scripts`)
  }
  return true
}

async function validateTrackedCover() {
  validateCoverSource(await readFile(SOURCE_PATH, "utf8"))
  return validateCoverImage(await readFile(DEFAULT_OUTPUT_PATH))
}

async function writeImage(outputPath, image) {
  let existing = null
  try {
    existing = await lstat(outputPath)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new CoverError("Cover output path must be a regular file")
  }
  const directory = path.dirname(outputPath)
  await mkdir(directory, { recursive: true })
  const temporaryPath = path.join(
    directory,
    `.${path.basename(outputPath)}.tmp-${process.pid}-${randomUUID()}`,
  )
  try {
    await writeFile(temporaryPath, image, { flag: "wx" })
    await rename(temporaryPath, outputPath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

export function verifyBrowserExecutable(executablePath) {
  if (!existsSync(executablePath)) {
    throw new CoverError(
      "Playwright Chromium is unavailable; run npx playwright install chromium",
      EXIT.MISSING_DEPENDENCY,
    )
  }
}

async function captureCover(outputPath) {
  validateCoverSource(await readFile(SOURCE_PATH, "utf8"))
  verifyBrowserExecutable(chromium.executablePath())
  let browser
  try {
    browser = await chromium.launch()
  } catch {
    throw new CoverError("Playwright Chromium could not launch", EXIT.MISSING_DEPENDENCY)
  }
  try {
    const context = await browser.newContext({
      colorScheme: "dark",
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
      viewport: { height: COVER_HEIGHT, width: COVER_WIDTH },
    })
    const page = await context.newPage()
    const browserErrors = []
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text())
    })
    page.on("pageerror", (error) => browserErrors.push(error.message))
    const response = await page.goto(pathToFileURL(SOURCE_PATH).href, {
      waitUntil: "load",
    })
    if (response && !response.ok()) {
      throw new CoverError(`Cover source returned HTTP ${response.status()}`, EXIT.RUNTIME)
    }
    const state = await page.evaluate(async () => {
      await document.fonts.ready
      const root = document.querySelector("[data-cover-root]")
      const rectangle = root?.getBoundingClientRect()
      return {
        bodyText: document.body.innerText.trim(),
        height: rectangle?.height ?? 0,
        overflow: document.documentElement.scrollHeight > window.innerHeight
          || document.documentElement.scrollWidth > window.innerWidth,
        width: rectangle?.width ?? 0,
      }
    })
    if (!state.bodyText || state.width !== COVER_WIDTH || state.height !== COVER_HEIGHT) {
      throw new CoverError("Cover source did not render at the expected size", EXIT.RUNTIME)
    }
    if (state.overflow) throw new CoverError("Cover source overflowed the viewport", EXIT.RUNTIME)
    if (browserErrors.length > 0) {
      throw new CoverError(`Cover source reported errors: ${browserErrors.join("; ")}`, EXIT.RUNTIME)
    }
    const image = await page.screenshot({
      animations: "disabled",
      fullPage: false,
      type: "png",
    })
    validateCoverImage(image)
    await writeImage(outputPath, image)
  } finally {
    await browser.close()
  }
}

export async function main(argv = process.argv.slice(2), streams = {}) {
  const stderr = streams.stderr ?? process.stderr
  const stdout = streams.stdout ?? process.stdout
  let parsed
  try {
    parsed = parseArguments(argv)
  } catch (error) {
    stderr.write(`capture-cover: ${error.message}\n`)
    stderr.write("Try npm run capture:cover -- --help\n")
    return error.exitCode ?? EXIT.USAGE
  }
  if (parsed.mode === MODE.HELP) {
    stdout.write(usage())
    return EXIT.SUCCESS
  }
  try {
    const dimensions = parsed.mode === MODE.CHECK
      ? await validateTrackedCover()
      : (await captureCover(parsed.outputPath), { height: COVER_HEIGHT, width: COVER_WIDTH })
    stdout.write(
      parsed.mode === MODE.CHECK
        ? `Cover checks passed (${dimensions.width}x${dimensions.height})\n`
        : `Wrote ${parsed.outputPath} (${dimensions.width}x${dimensions.height})\n`,
    )
    return EXIT.SUCCESS
  } catch (error) {
    stderr.write(`capture-cover: ${error.message}\n`)
    return error.exitCode ?? EXIT.RUNTIME
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main()
}

export { CoverError, EXIT, MODE }
