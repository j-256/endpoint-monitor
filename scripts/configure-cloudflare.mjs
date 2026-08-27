#!/usr/bin/env node

import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { portableConfiguration } from "../src/config.mjs"
import { sha256Hex } from "../src/crypto.mjs"

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const EXAMPLE_WRANGLER_PATH = path.join(PROJECT_ROOT, "wrangler.example.jsonc")
const DEFAULT_OUTPUT_PATH = path.join(PROJECT_ROOT, "wrangler.jsonc")
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/
const DATABASE_ID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const SERVICE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const CONFIGURATION_SQL = `
  INSERT INTO monitor_configuration (
    singleton_id,
    schema_version,
    config_json,
    config_fingerprint,
    target_count,
    updated_at
  ) VALUES (1, ?, ?, ?, ?, ?)
  ON CONFLICT (singleton_id) DO UPDATE SET
    schema_version = excluded.schema_version,
    config_json = excluded.config_json,
    config_fingerprint = excluded.config_fingerprint,
    target_count = excluded.target_count,
    updated_at = excluded.updated_at
  WHERE monitor_configuration.config_fingerprint <> excluded.config_fingerprint
`

const EXIT = Object.freeze({ RUNTIME: 1, SUCCESS: 0, USAGE: 2 })

class ConfigureError extends Error {
  constructor(message, exitCode = EXIT.USAGE) {
    super(message)
    this.exitCode = exitCode
  }
}

function usage() {
  return `Usage: endpoint-monitor cloudflare configure --config <path> --database-id <uuid> [options]

Prepare an ignored mode-0600 wrangler.jsonc and optionally store the validated target document in an existing migrated D1 database. The command never creates Cloudflare resources or installs secrets.

Target documents are JSON with schemaVersion 1, optional defaults, and a targets array. Each target requires a lower-case DNS-style id and an absolute public HTTP or HTTPS url.

Required options:
  -c, --config <path>              Target document
  -d, --database-id <uuid>         Existing D1 database identifier

Options:
  -o, --output <path>              Generated Wrangler path (default: wrangler.jsonc)
  -p, --operator-profile <path>    Operator profile (default: beside Wrangler config)
  -w, --worker-name <name>         Worker name (default: endpoint-monitor)
  -s, --hookrelay-service <name>   Optional Hookrelay service binding target
  -a, --analytics                  Enable Cloudflare analytics enrichment
  -e, --enabled                    Enable scheduled monitoring
  -l, --delivery                   Enable Hookrelay delivery
  -t, --status                     Enable authenticated status output
  -n, --dry-run                    Validate and print the plan without writes
      --apply-config               Upsert configuration into D1
  -h, --help                       Show this help

Environment required by --analytics or --apply-config:
  CLOUDFLARE_ACCOUNT_ID            32-character account identifier

Environment required by --apply-config:
  CLOUDFLARE_API_TOKEN             Token with D1 write access

Install ENDPOINT_MONITOR_HOOKRELAY_URL and ENDPOINT_MONITOR_HOOKRELAY_HMAC before enabling delivery, CLOUDFLARE_API_TOKEN before enabling analytics, and ENDPOINT_MONITOR_STATUS_TOKEN before enabling status. Apply migrations before --apply-config.

Exit status:
  0  Preparation or apply succeeded
  1  File write or Cloudflare API operation failed
  2  Usage, environment, or configuration error
`
}

function readOptionValue(argv, index, attached, name) {
  if (attached !== null) {
    if (!attached) throw new ConfigureError(`${name} requires a value`)
    return { index, value: attached }
  }
  const value = argv[index + 1]
  if (value === undefined || value === "") {
    throw new ConfigureError(`${name} requires a value`)
  }
  return { index: index + 1, value }
}

export function parseConfigureArguments(argv) {
  const options = {
    analytics: false,
    applyConfig: false,
    configPath: null,
    databaseId: null,
    delivery: false,
    dryRun: false,
    enabled: false,
    help: false,
    hookrelayService: null,
    operatorProfilePath: null,
    outputPath: DEFAULT_OUTPUT_PATH,
    status: false,
    workerName: "endpoint-monitor",
  }
  const valueOptions = new Map([
    ["c", "configPath"],
    ["d", "databaseId"],
    ["o", "outputPath"],
    ["p", "operatorProfilePath"],
    ["s", "hookrelayService"],
    ["w", "workerName"],
  ])
  const longValues = new Map([
    ["--config", "configPath"],
    ["--database-id", "databaseId"],
    ["--hookrelay-service", "hookrelayService"],
    ["--operator-profile", "operatorProfilePath"],
    ["--output", "outputPath"],
    ["--worker-name", "workerName"],
  ])
  const longFlags = new Map([
    ["--analytics", "analytics"],
    ["--apply-config", "applyConfig"],
    ["--delivery", "delivery"],
    ["--dry-run", "dryRun"],
    ["--enabled", "enabled"],
    ["--help", "help"],
    ["--status", "status"],
  ])
  const shortFlags = new Map([
    ["a", "analytics"],
    ["e", "enabled"],
    ["h", "help"],
    ["l", "delivery"],
    ["n", "dryRun"],
    ["t", "status"],
  ])
  let passthrough = false
  const positionals = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (passthrough || argument === "-" || !argument.startsWith("-")) {
      positionals.push(argument)
      continue
    }
    if (argument === "--") {
      passthrough = true
      continue
    }
    if (argument.startsWith("--")) {
      const equals = argument.indexOf("=")
      const name = equals === -1 ? argument : argument.slice(0, equals)
      const attached = equals === -1 ? null : argument.slice(equals + 1)
      if (longFlags.has(name)) {
        if (attached !== null) throw new ConfigureError(`${name} does not take a value`)
        options[longFlags.get(name)] = true
      } else if (longValues.has(name)) {
        const parsed = readOptionValue(argv, index, attached, name)
        options[longValues.get(name)] = parsed.value
        index = parsed.index
      } else {
        throw new ConfigureError(`Unknown option: ${name}`)
      }
      continue
    }
    let bundle = argument.slice(1)
    while (bundle) {
      const name = bundle[0]
      bundle = bundle.slice(1)
      if (shortFlags.has(name)) {
        options[shortFlags.get(name)] = true
      } else if (valueOptions.has(name)) {
        const parsed = readOptionValue(argv, index, bundle || null, `-${name}`)
        options[valueOptions.get(name)] = parsed.value
        index = parsed.index
        bundle = ""
      } else {
        throw new ConfigureError(`Unknown option: -${name}`)
      }
    }
  }
  if (positionals.length > 0) {
    throw new ConfigureError(`Unexpected argument: ${positionals[0]}`)
  }
  if (options.help) return Object.freeze(options)
  if (!options.configPath) throw new ConfigureError("--config is required")
  if (!DATABASE_ID_PATTERN.test(options.databaseId || "")) {
    throw new ConfigureError("--database-id must be a lower-case UUID")
  }
  if (!SERVICE_NAME_PATTERN.test(options.workerName)) {
    throw new ConfigureError("--worker-name is invalid")
  }
  if (options.hookrelayService
    && !SERVICE_NAME_PATTERN.test(options.hookrelayService)) {
    throw new ConfigureError("--hookrelay-service is invalid")
  }
  options.outputPath = path.resolve(options.outputPath)
  options.operatorProfilePath = path.resolve(
    options.operatorProfilePath
      ?? path.join(path.dirname(options.outputPath), ".endpoint-monitor.local.json"),
  )
  if (new Set([
    path.resolve(options.configPath),
    options.operatorProfilePath,
    options.outputPath,
  ]).size !== 3) {
    throw new ConfigureError("Target, Wrangler, and operator profile paths must be distinct")
  }
  return Object.freeze(options)
}

async function loadTargetConfiguration(configPath, readFileImpl) {
  let source
  try {
    source = await readFileImpl(configPath, "utf8")
  } catch {
    throw new ConfigureError(`Cannot read configuration: ${configPath}`)
  }
  let candidate
  try {
    candidate = JSON.parse(source)
  } catch {
    throw new ConfigureError(`Configuration is not valid JSON: ${configPath}`)
  }
  try {
    const portable = portableConfiguration(candidate)
    const configJson = JSON.stringify(portable)
    return Object.freeze({
      configFingerprint: `sha256:${await sha256Hex(configJson)}`,
      configJson,
      portable,
    })
  } catch (error) {
    throw new ConfigureError(error.message)
  }
}

function accountId(environment, required) {
  const value = environment.CLOUDFLARE_ACCOUNT_ID
  if (!required && !value) return null
  if (typeof value !== "string" || !ACCOUNT_ID_PATTERN.test(value)) {
    throw new ConfigureError("CLOUDFLARE_ACCOUNT_ID is unavailable or invalid")
  }
  return value
}

export function buildWranglerConfiguration(example, options, resolvedAccountId) {
  const vars = {
    CLOUDFLARE_ANALYTICS_ENABLED: String(options.analytics),
    ENDPOINT_MONITOR_DELIVERY_ENABLED: String(options.delivery),
    ENDPOINT_MONITOR_ENABLED: String(options.enabled),
    ENDPOINT_MONITOR_STATUS_ENABLED: String(options.status),
  }
  if (options.analytics) vars.CLOUDFLARE_ACCOUNT_ID = resolvedAccountId
  return {
    ...example,
    d1_databases: example.d1_databases.map((binding) => ({
      ...binding,
      database_id: options.databaseId,
    })),
    name: options.workerName,
    services: options.hookrelayService
      ? [{ binding: "HOOKRELAY", service: options.hookrelayService }]
      : [],
    vars,
  }
}

async function writePrivateFile(outputPath, contents, dependencies) {
  let existing = null
  try {
    existing = await dependencies.lstatImpl(outputPath)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error("Generated Wrangler path must be a regular file")
  }
  const directory = path.dirname(outputPath)
  await dependencies.mkdirImpl(directory, { mode: 0o700, recursive: true })
  const temporary = path.join(
    directory,
    `.${path.basename(outputPath)}.tmp-${process.pid}-${crypto.randomUUID()}`,
  )
  try {
    await dependencies.writeFileImpl(temporary, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    await dependencies.renameImpl(temporary, outputPath)
    await dependencies.chmodImpl(outputPath, 0o600)
  } catch (error) {
    try {
      await dependencies.unlinkImpl(temporary)
    } catch {}
    throw error
  }
}

export async function applyConfiguration(
  fetchImpl,
  resolvedAccountId,
  apiToken,
  databaseId,
  loaded,
  updatedAt,
) {
  if (typeof apiToken !== "string" || !apiToken) {
    throw new ConfigureError("CLOUDFLARE_API_TOKEN is unavailable")
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${resolvedAccountId}/d1/database/${databaseId}/query`
  let response
  try {
    response = await fetchImpl(url, {
      body: JSON.stringify({
        params: [
          String(loaded.portable.schemaVersion),
          loaded.configJson,
          loaded.configFingerprint,
          String(loaded.portable.targets.length),
          updatedAt,
        ],
        sql: CONFIGURATION_SQL,
      }),
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    })
  } catch {
    throw new ConfigureError("Cloudflare D1 configuration request failed", EXIT.RUNTIME)
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new ConfigureError("Cloudflare D1 returned invalid JSON", EXIT.RUNTIME)
  }
  if (!response.ok
    || payload.success !== true
    || !Array.isArray(payload.result)
    || payload.result.some((entry) => entry.success === false)) {
    throw new ConfigureError("Cloudflare D1 rejected configuration", EXIT.RUNTIME)
  }
  return payload.result.reduce(
    (total, entry) => total + Number(entry.meta?.rows_written || 0),
    0,
  )
}

function outputPlan(options, loaded, resolvedAccountId, rowsWritten = null) {
  return Object.freeze({
    analytics: options.analytics,
    applyConfig: options.applyConfig,
    applied: rowsWritten !== null,
    configFingerprint: loaded.configFingerprint,
    databaseId: options.databaseId,
    delivery: options.delivery,
    dryRun: options.dryRun,
    enabled: options.enabled,
    hookrelayService: options.hookrelayService,
    operatorProfilePath: options.operatorProfilePath,
    outputPath: path.resolve(options.outputPath),
    rowsWritten,
    status: options.status,
    targetCount: loaded.portable.targets.length,
    workerName: options.workerName,
    ...(resolvedAccountId ? { accountId: resolvedAccountId } : {}),
  })
}

function writeLine(stream, value) {
  stream.write(`${value}\n`)
}

export async function runConfigure(
  argv,
  {
    chmodImpl = chmod,
    clock = Date.now,
    environment = process.env,
    examplePath = EXAMPLE_WRANGLER_PATH,
    fetchImpl = globalThis.fetch,
    lstatImpl = lstat,
    mkdirImpl = mkdir,
    readFileImpl = readFile,
    renameImpl = rename,
    stderr = process.stderr,
    stdout = process.stdout,
    unlinkImpl = unlink,
    writeFileImpl = writeFile,
  } = {},
) {
  let options
  try {
    options = parseConfigureArguments(argv)
  } catch (error) {
    writeLine(stderr, `endpoint-monitor: ${error.message}`)
    return error.exitCode || EXIT.USAGE
  }
  if (options.help) {
    stdout.write(usage())
    return EXIT.SUCCESS
  }
  let loaded
  let example
  let resolvedAccountId
  try {
    loaded = await loadTargetConfiguration(options.configPath, readFileImpl)
    example = JSON.parse(await readFileImpl(examplePath, "utf8"))
    resolvedAccountId = accountId(
      environment,
      options.analytics || options.applyConfig,
    )
  } catch (error) {
    writeLine(stderr, `endpoint-monitor: ${error.message}`)
    return error.exitCode || EXIT.USAGE
  }
  if (options.dryRun) {
    writeLine(stdout, JSON.stringify(outputPlan(options, loaded, resolvedAccountId)))
    return EXIT.SUCCESS
  }
  const wrangler = buildWranglerConfiguration(example, options, resolvedAccountId)
  try {
    await writePrivateFile(
      options.outputPath,
      `${JSON.stringify(wrangler, null, 2)}\n`,
      {
        chmodImpl,
        lstatImpl,
        mkdirImpl,
        renameImpl,
        unlinkImpl,
        writeFileImpl,
      },
    )
    await writePrivateFile(
      options.operatorProfilePath,
      `${JSON.stringify({
        configPath: path.resolve(options.configPath),
        schemaVersion: 1,
        wranglerPath: path.resolve(options.outputPath),
      }, null, 2)}\n`,
      {
        chmodImpl,
        lstatImpl,
        mkdirImpl,
        renameImpl,
        unlinkImpl,
        writeFileImpl,
      },
    )
  } catch {
    writeLine(stderr, "endpoint-monitor: Cannot write generated local configuration")
    return EXIT.RUNTIME
  }
  let rowsWritten = null
  if (options.applyConfig) {
    try {
      rowsWritten = await applyConfiguration(
        fetchImpl,
        resolvedAccountId,
        environment.CLOUDFLARE_API_TOKEN,
        options.databaseId,
        loaded,
        new Date(clock()).toISOString(),
      )
    } catch (error) {
      writeLine(stderr, `endpoint-monitor: ${error.message}`)
      return error.exitCode || EXIT.RUNTIME
    }
  }
  writeLine(
    stdout,
    JSON.stringify(outputPlan(options, loaded, resolvedAccountId, rowsWritten)),
  )
  return EXIT.SUCCESS
}

export { EXIT, usage }
