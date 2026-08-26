#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { applyConfiguration } from "./configure-cloudflare.mjs"
import {
  normalizeConfiguration,
  portableConfiguration,
} from "../src/config.mjs"
import { sha256Hex } from "../src/crypto.mjs"
import { isMainModule } from "../src/main-module.mjs"
import { runCli } from "../src/cli.mjs"

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DEFAULT_PROFILE_PATH = path.join(PROJECT_ROOT, ".endpoint-monitor.local.json")
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/
const DATABASE_ID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const COMMANDS = new Set(["list", "path", "probe", "sync"])
const EXIT = Object.freeze({ RUNTIME: 1, SUCCESS: 0, USAGE: 2 })

class TargetsError extends Error {
  constructor(message, exitCode = EXIT.USAGE) {
    super(message)
    this.exitCode = exitCode
  }
}

function usage() {
  return `Usage: npm run targets -- [command] [options]

Use the ignored local operator profile written by configure-cloudflare.

Commands:
  list                 Show configured endpoint IDs, methods, status contracts, and URLs (default)
  path                 Show the canonical target document path
  probe                Probe every configured target once without persistence or delivery
  sync                 Idempotently store the target document in the configured D1 database

Options:
  -p, --profile <path>  Local operator profile (default: .endpoint-monitor.local.json)
  -j, --json            Write machine-readable output
  -h, --help            Show this help

Exit status:
  0  Command succeeded
  1  Probe, file, or Cloudflare operation failed
  2  Usage or local configuration error
`
}

function optionValue(argv, index, attached, name) {
  if (attached !== null) {
    if (!attached) throw new TargetsError(`${name} requires a value`)
    return { index, value: attached }
  }
  const value = argv[index + 1]
  if (!value) throw new TargetsError(`${name} requires a value`)
  return { index: index + 1, value }
}

export function parseTargetsArguments(argv) {
  const options = {
    command: null,
    help: false,
    json: false,
    profilePath: DEFAULT_PROFILE_PATH,
  }
  let passthrough = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--" && !passthrough) {
      passthrough = true
      continue
    }
    if (passthrough || argument === "-" || !argument.startsWith("-")) {
      if (options.command !== null) throw new TargetsError(`Unexpected argument: ${argument}`)
      if (!COMMANDS.has(argument)) throw new TargetsError(`Unknown command: ${argument}`)
      options.command = argument
      continue
    }
    if (argument.startsWith("--")) {
      const equals = argument.indexOf("=")
      const name = equals === -1 ? argument : argument.slice(0, equals)
      const attached = equals === -1 ? null : argument.slice(equals + 1)
      if (name === "--help") {
        if (attached !== null) throw new TargetsError("--help does not take a value")
        options.help = true
      } else if (name === "--json") {
        if (attached !== null) throw new TargetsError("--json does not take a value")
        options.json = true
      } else if (name === "--profile") {
        const parsed = optionValue(argv, index, attached, name)
        options.profilePath = parsed.value
        index = parsed.index
      } else {
        throw new TargetsError(`Unknown option: ${name}`)
      }
      continue
    }
    let bundle = argument.slice(1)
    while (bundle) {
      const name = bundle[0]
      bundle = bundle.slice(1)
      if (name === "h") {
        options.help = true
      } else if (name === "j") {
        options.json = true
      } else if (name === "p") {
        const parsed = optionValue(argv, index, bundle || null, "-p")
        options.profilePath = parsed.value
        index = parsed.index
        bundle = ""
      } else {
        throw new TargetsError(`Unknown option: -${name}`)
      }
    }
  }
  options.command ??= "list"
  options.profilePath = path.resolve(options.profilePath)
  return Object.freeze(options)
}

async function readPrivateJson(filename, label, dependencies) {
  let metadata
  let source
  try {
    metadata = await dependencies.lstatImpl(filename)
    if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o077) !== 0) {
      throw new Error("unsafe file")
    }
    source = await dependencies.readFileImpl(filename, "utf8")
  } catch {
    throw new TargetsError(`${label} must be a mode-0600 regular file`, EXIT.RUNTIME)
  }
  try {
    return JSON.parse(source)
  } catch {
    throw new TargetsError(`${label} is not valid JSON`, EXIT.RUNTIME)
  }
}

function operatorProfile(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || value.schemaVersion !== 1
    || typeof value.configPath !== "string"
    || !path.isAbsolute(value.configPath)
    || typeof value.wranglerPath !== "string"
    || !path.isAbsolute(value.wranglerPath)
    || Object.keys(value).some((key) => !["configPath", "schemaVersion", "wranglerPath"].includes(key))) {
    throw new TargetsError("Local operator profile is invalid", EXIT.RUNTIME)
  }
  return Object.freeze(value)
}

async function loadConfiguration(configPath, dependencies) {
  const candidate = await readPrivateJson(configPath, "Target document", dependencies)
  let portable
  try {
    normalizeConfiguration(candidate)
    portable = portableConfiguration(candidate)
  } catch (error) {
    throw new TargetsError(error.message, EXIT.RUNTIME)
  }
  const configJson = JSON.stringify(portable)
  return Object.freeze({
    configFingerprint: `sha256:${await sha256Hex(configJson)}`,
    configJson,
    portable,
  })
}

function databaseId(wrangler) {
  const binding = wrangler?.d1_databases?.find((entry) => entry.binding === "MONITOR_DB")
  if (!binding || !DATABASE_ID_PATTERN.test(binding.database_id || "")) {
    throw new TargetsError("Generated Wrangler configuration has no valid MONITOR_DB binding", EXIT.RUNTIME)
  }
  return binding.database_id
}

function listOutput(loaded, configPath, json) {
  const targets = loaded.portable.targets.map((target) => ({
    expectedStatuses: target.expectedStatuses ?? null,
    id: target.id,
    method: target.method,
    url: target.url,
  }))
  if (json) return `${JSON.stringify({ configPath, targets })}\n`
  const lines = ["ID\tMETHOD\tEXPECTED\tURL"]
  for (const target of targets) {
    lines.push([
      target.id,
      target.method,
      target.expectedStatuses?.join(",") ?? "<500",
      target.url,
    ].join("\t"))
  }
  lines.push(`${targets.length} target(s)`)
  return `${lines.join("\n")}\n`
}

export async function runTargets(
  argv,
  {
    clock = Date.now,
    environment = process.env,
    fetchImpl = globalThis.fetch,
    lstatImpl = lstat,
    readFileImpl = readFile,
    stderr = process.stderr,
    stdout = process.stdout,
  } = {},
) {
  let options
  try {
    options = parseTargetsArguments(argv)
  } catch (error) {
    stderr.write(`endpoint-monitor-targets: ${error.message}\n`)
    return error.exitCode || EXIT.USAGE
  }
  if (options.help) {
    stdout.write(usage())
    return EXIT.SUCCESS
  }
  const dependencies = { lstatImpl, readFileImpl }
  let profile
  try {
    profile = operatorProfile(await readPrivateJson(
      options.profilePath,
      "Local operator profile",
      dependencies,
    ))
  } catch (error) {
    stderr.write(`endpoint-monitor-targets: ${error.message}\n`)
    return error.exitCode || EXIT.RUNTIME
  }
  if (options.command === "path") {
    stdout.write(options.json
      ? `${JSON.stringify({ configPath: profile.configPath })}\n`
      : `${profile.configPath}\n`)
    return EXIT.SUCCESS
  }
  if (options.command === "probe") {
    return runCli(
      ["probe", ...(options.json ? ["--json"] : []), profile.configPath],
      { clock, fetchImpl, readFileImpl, stderr, stdout },
    )
  }
  let loaded
  try {
    loaded = await loadConfiguration(profile.configPath, dependencies)
  } catch (error) {
    stderr.write(`endpoint-monitor-targets: ${error.message}\n`)
    return error.exitCode || EXIT.RUNTIME
  }
  if (options.command === "list") {
    stdout.write(listOutput(loaded, profile.configPath, options.json))
    return EXIT.SUCCESS
  }
  let wrangler
  try {
    wrangler = await readPrivateJson(
      profile.wranglerPath,
      "Generated Wrangler configuration",
      dependencies,
    )
  } catch (error) {
    stderr.write(`endpoint-monitor-targets: ${error.message}\n`)
    return error.exitCode || EXIT.RUNTIME
  }
  const resolvedAccountId = environment.CLOUDFLARE_ACCOUNT_ID
  if (!ACCOUNT_ID_PATTERN.test(resolvedAccountId || "")) {
    stderr.write("endpoint-monitor-targets: CLOUDFLARE_ACCOUNT_ID is unavailable or invalid\n")
    return EXIT.RUNTIME
  }
  let rowsWritten
  try {
    rowsWritten = await applyConfiguration(
      fetchImpl,
      resolvedAccountId,
      environment.CLOUDFLARE_API_TOKEN,
      databaseId(wrangler),
      loaded,
      new Date(clock()).toISOString(),
    )
  } catch (error) {
    stderr.write(`endpoint-monitor-targets: ${error.message}\n`)
    return error.exitCode || EXIT.RUNTIME
  }
  const result = {
    configFingerprint: loaded.configFingerprint,
    rowsWritten,
    targetCount: loaded.portable.targets.length,
  }
  stdout.write(options.json
    ? `${JSON.stringify(result)}\n`
    : `Synchronized ${result.targetCount} target(s); D1 rows written: ${result.rowsWritten}\n`)
  return EXIT.SUCCESS
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runTargets(process.argv.slice(2))
}

export { EXIT, usage }
