#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process"
import { createHash } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

import { isMainModule } from "../src/main-module.mjs"

const execFile = promisify(execFileCallback)
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DIST_DIRECTORY = path.join(PROJECT_ROOT, "dist")
const PACKAGE_NAME = "@j-256/endpoint-monitor"
const PLACEHOLDER_DATABASE_ID = "00000000-0000-0000-0000-000000000000"
const PACKAGE_FILES = Object.freeze([
  "CHANGELOG.md",
  "docs/architecture.md",
  "docs/cloudflare.md",
  "docs/releases.md",
  "endpoint-monitor.example.json",
  "migrations/",
  "scripts/configure-cloudflare.mjs",
  "src/",
  "wrangler.example.jsonc",
])
const REQUIRED_ARCHIVE_FILES = Object.freeze([
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "docs/architecture.md",
  "docs/cloudflare.md",
  "docs/releases.md",
  "endpoint-monitor.example.json",
  "migrations/0001_initial.sql",
  "migrations/0002_incident_triage.sql",
  "package.json",
  "scripts/configure-cloudflare.mjs",
  "src/adapters/cloudflare/worker.mjs",
  "src/adapters/cloudflare/deployment.mjs",
  "src/cli.mjs",
  "src/core.mjs",
  "src/project.mjs",
  "wrangler.example.jsonc",
])
const ARCHIVE_EXACT_PATHS = new Set([
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "docs/architecture.md",
  "docs/cloudflare.md",
  "docs/releases.md",
  "endpoint-monitor.example.json",
  "package.json",
  "scripts/configure-cloudflare.mjs",
  "wrangler.example.jsonc",
])
const ARCHIVE_PREFIXES = Object.freeze(["migrations/", "src/"])
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/
const COMMAND = Object.freeze({
  BUILD: "build",
  CHECK: "check",
  HELP: "help",
})
const EXIT = Object.freeze({
  MISSING_DEPENDENCY: 3,
  RUNTIME: 1,
  SUCCESS: 0,
  USAGE: 2,
})

class ReleaseError extends Error {
  constructor(message, exitCode = EXIT.USAGE) {
    super(message)
    this.exitCode = exitCode
  }
}

export function usage() {
  return `Usage: node scripts/release.mjs <command> [options]

Validate or build the installable npm-format archive distributed through
GitHub Releases. The build command recreates dist/ and writes the package
tarball and SHA256SUMS. Neither command publishes, tags, pushes, or deploys.

Commands:
  check                 Validate metadata, changelog, package contents, and install
  build                 Validate and write the release artifacts under dist/

Options:
  -t, --tag <vX.Y.Z>    Require an exact tag match for the package version
  -h, --help            Show this help

Environment:
  GITHUB_REF_TYPE       Uses GITHUB_REF_NAME when the value is tag
  GITHUB_REF_NAME       Tag supplied by GitHub Actions

Exit status:
  0  Release validation or build succeeded
  1  Packaging, installation, or file operation failed
  2  Usage or release precondition is invalid
  3  npm or Node.js is unavailable
`
}

function optionValue(argv, index, attached, name) {
  if (attached !== null) {
    if (!attached) throw new ReleaseError(`${name} requires a value`)
    return { index, value: attached }
  }
  const value = argv[index + 1]
  if (value === undefined || value === "") {
    throw new ReleaseError(`${name} requires a value`)
  }
  return { index: index + 1, value }
}

export function parseArguments(argv, environment = process.env) {
  let endOfOptions = false
  let help = false
  let tag = null
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (endOfOptions || argument === "-" || !argument.startsWith("-")) {
      positionals.push(argument)
      continue
    }
    if (argument === "--") {
      endOfOptions = true
      continue
    }
    if (argument.startsWith("--")) {
      const equals = argument.indexOf("=")
      const name = equals === -1 ? argument : argument.slice(0, equals)
      const attached = equals === -1 ? null : argument.slice(equals + 1)
      if (name === "--help") {
        if (attached !== null) throw new ReleaseError("--help does not take a value")
        help = true
      } else if (name === "--tag") {
        const parsed = optionValue(argv, index, attached, name)
        tag = parsed.value
        index = parsed.index
      } else {
        throw new ReleaseError(`Unknown option: ${name}`)
      }
      continue
    }
    let bundle = argument.slice(1)
    while (bundle) {
      const name = bundle[0]
      bundle = bundle.slice(1)
      if (name === "h") {
        help = true
      } else if (name === "t") {
        const parsed = optionValue(argv, index, bundle || null, "-t")
        tag = parsed.value
        index = parsed.index
        bundle = ""
      } else {
        throw new ReleaseError(`Unknown option: -${name}`)
      }
    }
  }
  if (help) return Object.freeze({ command: COMMAND.HELP, tag: null })
  if (positionals.length === 0) throw new ReleaseError("A command is required")
  if (positionals.length > 1) {
    throw new ReleaseError(`Unexpected argument: ${positionals[1]}`)
  }
  if (![COMMAND.BUILD, COMMAND.CHECK].includes(positionals[0])) {
    throw new ReleaseError(`Unknown command: ${positionals[0]}`)
  }
  const environmentTag = environment.GITHUB_REF_TYPE === "tag"
    ? environment.GITHUB_REF_NAME
    : null
  if (tag && environmentTag && tag !== environmentTag) {
    throw new ReleaseError("Command tag does not match the GitHub Actions tag")
  }
  return Object.freeze({ command: positionals[0], tag: tag ?? environmentTag ?? null })
}

function releaseHeading(version) {
  return new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m")
}

export function validateReleaseMetadata(packageJson, packageLock, changelog, tag = null) {
  const issues = []
  if (packageJson.name !== PACKAGE_NAME) {
    issues.push(`package name must be ${PACKAGE_NAME}`)
  }
  if (!VERSION_PATTERN.test(packageJson.version || "")) {
    issues.push("package version must be semantic version X.Y.Z with an optional prerelease")
  }
  if (packageJson.private !== true) {
    issues.push("package must remain private because releases are distributed through GitHub")
  }
  if (JSON.stringify(packageJson.files) !== JSON.stringify(PACKAGE_FILES)) {
    issues.push("package files must match the release allowlist")
  }
  if (packageLock.name !== packageJson.name || packageLock.version !== packageJson.version) {
    issues.push("package-lock root identity does not match package.json")
  }
  const lockRoot = packageLock.packages?.[""]
  if (lockRoot?.name !== packageJson.name || lockRoot?.version !== packageJson.version) {
    issues.push("package-lock package metadata does not match package.json")
  }
  if (!releaseHeading(packageJson.version || "").test(changelog)) {
    issues.push(`CHANGELOG.md is missing a dated ${packageJson.version} release heading`)
  }
  if (tag && tag !== `v${packageJson.version}`) {
    issues.push(`release tag must be v${packageJson.version}`)
  }
  return Object.freeze(issues)
}

function archivePathAllowed(filename) {
  return ARCHIVE_EXACT_PATHS.has(filename)
    || ARCHIVE_PREFIXES.some((prefix) => filename.startsWith(prefix))
}

export function validateArchiveFiles(files) {
  const paths = files.map((entry) => entry.path)
  const issues = []
  for (const required of REQUIRED_ARCHIVE_FILES) {
    if (!paths.includes(required)) issues.push(`archive is missing ${required}`)
  }
  for (const filename of paths) {
    if (!archivePathAllowed(filename)) issues.push(`archive contains unexpected ${filename}`)
  }
  return Object.freeze(issues)
}

export function parsePackOutput(output) {
  let parsed
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new ReleaseError("npm pack returned invalid JSON", EXIT.RUNTIME)
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0].files)) {
    throw new ReleaseError("npm pack returned an unexpected result", EXIT.RUNTIME)
  }
  return parsed[0]
}

async function run(command, argumentsList, options = {}) {
  try {
    return await execFile(command, argumentsList, {
      cwd: options.cwd ?? PROJECT_ROOT,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ReleaseError(`${command} is unavailable`, EXIT.MISSING_DEPENDENCY)
    }
    const status = Number.isInteger(error?.code) ? error.code : "unknown"
    throw new ReleaseError(`${command} exited with status ${status}`, EXIT.RUNTIME)
  }
}

async function readProjectMetadata() {
  const [packageSource, lockSource, changelog] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"),
    readFile(path.join(PROJECT_ROOT, "package-lock.json"), "utf8"),
    readFile(path.join(PROJECT_ROOT, "CHANGELOG.md"), "utf8"),
  ])
  return Object.freeze({
    changelog,
    packageJson: JSON.parse(packageSource),
    packageLock: JSON.parse(lockSource),
  })
}

async function inspectArchive() {
  const result = await run("npm", [
    "pack",
    "--dry-run",
    "--ignore-scripts",
    "--json",
  ])
  const archive = parsePackOutput(result.stdout)
  const issues = validateArchiveFiles(archive.files)
  if (issues.length > 0) throw new ReleaseError(issues.join("; "))
  return archive
}

async function packTo(destination) {
  await mkdir(destination, { recursive: true })
  const result = await run("npm", [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    destination,
  ])
  return parsePackOutput(result.stdout)
}

async function smokeInstall() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "endpoint-monitor-release-"))
  try {
    await writeFile(
      path.join(directory, "package.json"),
      `${JSON.stringify({ private: true })}\n`,
      "utf8",
    )
    const archive = await packTo(directory)
    const archivePath = path.join(directory, archive.filename)
    await run("npm", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      archivePath,
    ], { cwd: directory })
    const executable = process.platform === "win32"
      ? path.join(directory, "node_modules", ".bin", "endpoint-monitor.cmd")
      : path.join(directory, "node_modules", ".bin", "endpoint-monitor")
    const helpResult = await run(executable, ["--help"], { cwd: directory })
    if (!/^Usage: endpoint-monitor/m.test(helpResult.stdout)) {
      throw new ReleaseError("installed CLI help returned unexpected output", EXIT.RUNTIME)
    }
    const operatorDirectory = path.join(directory, "operator")
    const initResult = await run(executable, [
      "init",
      "--directory",
      operatorDirectory,
    ], { cwd: directory })
    if (!/^Initialized Endpoint Monitor project/m.test(initResult.stdout)) {
      throw new ReleaseError("installed init returned unexpected output", EXIT.RUNTIME)
    }
    const profilePath = path.join(operatorDirectory, ".endpoint-monitor.local.json")
    const targetPath = path.join(operatorDirectory, "endpoint-monitor.json")
    const wranglerPath = path.join(operatorDirectory, "wrangler.jsonc")
    const bootstrapResult = await run(executable, [
      "cloudflare",
      "bootstrap",
      "--profile",
      profilePath,
      "--dry-run",
    ], { cwd: directory })
    const bootstrapPlan = JSON.parse(bootstrapResult.stdout)
    if (bootstrapPlan.databaseAction !== "create" || bootstrapPlan.dryRun !== true) {
      throw new ReleaseError("installed bootstrap dry run returned unexpected output", EXIT.RUNTIME)
    }
    await run(executable, [
      "cloudflare",
      "configure",
      "--config",
      targetPath,
      "--database-id",
      PLACEHOLDER_DATABASE_ID,
      "--operator-profile",
      profilePath,
      "--output",
      wranglerPath,
    ], { cwd: directory })
    const deployResult = await run(executable, [
      "deploy",
      "--profile",
      profilePath,
      "--dry-run",
    ], { cwd: directory })
    if (!/Deployment dry run passed for endpoint-monitor/m.test(deployResult.stdout)) {
      throw new ReleaseError("installed deploy dry run returned unexpected output", EXIT.RUNTIME)
    }
    const validateResult = await run(executable, [
      "config",
      "validate",
      targetPath,
    ], { cwd: directory })
    if (!/^Valid target document with \d+ target\(s\)$/m.test(validateResult.stdout)) {
      throw new ReleaseError("installed CLI returned unexpected output", EXIT.RUNTIME)
    }
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

async function validateRelease(tag) {
  const metadata = await readProjectMetadata()
  const issues = validateReleaseMetadata(
    metadata.packageJson,
    metadata.packageLock,
    metadata.changelog,
    tag,
  )
  if (issues.length > 0) throw new ReleaseError(issues.join("; "))
  const archive = await inspectArchive()
  return Object.freeze({ archive, metadata })
}

async function checkRelease(tag) {
  const validated = await validateRelease(tag)
  await smokeInstall()
  return validated
}

async function buildRelease(tag) {
  const validated = await validateRelease(tag)
  await rm(DIST_DIRECTORY, { force: true, recursive: true })
  const archive = await packTo(DIST_DIRECTORY)
  const archivePath = path.join(DIST_DIRECTORY, archive.filename)
  const digest = createHash("sha256").update(await readFile(archivePath)).digest("hex")
  const checksumPath = path.join(DIST_DIRECTORY, "SHA256SUMS")
  await writeFile(checksumPath, `${digest}  ${archive.filename}\n`, {
    encoding: "utf8",
    flag: "wx",
  })
  return Object.freeze({
    archivePath,
    checksumPath,
    packageJson: validated.metadata.packageJson,
  })
}

export async function main(argv = process.argv.slice(2), streams = {}) {
  const stderr = streams.stderr ?? process.stderr
  const stdout = streams.stdout ?? process.stdout
  let parsed
  try {
    parsed = parseArguments(argv)
  } catch (error) {
    stderr.write(`release: ${error.message}\n`)
    stderr.write("Try node scripts/release.mjs --help\n")
    return error.exitCode ?? EXIT.USAGE
  }
  if (parsed.command === COMMAND.HELP) {
    stdout.write(usage())
    return EXIT.SUCCESS
  }
  try {
    if (parsed.command === COMMAND.CHECK) {
      const validated = await checkRelease(parsed.tag)
      stdout.write(
        `Release checks passed for ${validated.metadata.packageJson.name}`
        + `@${validated.metadata.packageJson.version}\n`,
      )
    } else {
      const built = await buildRelease(parsed.tag)
      stdout.write(`Wrote ${path.relative(PROJECT_ROOT, built.archivePath)}\n`)
      stdout.write(`Wrote ${path.relative(PROJECT_ROOT, built.checksumPath)}\n`)
    }
    return EXIT.SUCCESS
  } catch (error) {
    stderr.write(`release: ${error.message}\n`)
    return error.exitCode ?? EXIT.RUNTIME
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main()
}

export { COMMAND, EXIT, PACKAGE_FILES, ReleaseError }
