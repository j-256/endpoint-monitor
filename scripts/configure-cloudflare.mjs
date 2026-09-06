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

import {
  configurationCandidate,
  validateConfigurationExpectation,
} from "../src/adapters/cloudflare/configuration-authority.mjs"
import { CloudflareConfigurationOperator } from "../src/adapters/cloudflare/operator-configuration.mjs"
import {
  PACKAGE_MIGRATIONS_PATH,
  PACKAGE_WORKER_PATH,
  PACKAGE_WRANGLER_EXAMPLE_PATH,
  writePrivateFile,
} from "../src/project.mjs"

const EXAMPLE_WRANGLER_PATH = PACKAGE_WRANGLER_EXAMPLE_PATH
const DEFAULT_OUTPUT_PATH = path.resolve("wrangler.jsonc")
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/
const DATABASE_ID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const SERVICE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

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

Target documents are JSON with schemaVersion 1 or 2, optional defaults, and a targets array. Each target requires a lower-case DNS-style id and an absolute public HTTP or HTTPS url.

Required options:
  -c, --config <path>              Target document
  -d, --database-id <uuid>         Existing D1 database identifier

Options:
  -N, --database-name <name>       D1 database name (default: endpoint-monitor)
  -o, --output <path>              Generated Wrangler path (default: wrangler.jsonc)
  -p, --operator-profile <path>    Operator profile (default: beside Wrangler config)
  -w, --worker-name <name>         Worker name (default: endpoint-monitor)
  -s, --hookrelay-service <name>   Optional Hookrelay service binding target
  -a, --analytics                  Enable Cloudflare analytics enrichment
  -e, --enabled                    Enable scheduled monitoring
  -l, --delivery                   Enable Hookrelay delivery
  -t, --status                     Enable authenticated status output
  -n, --dry-run                    Validate and print the plan without writes
  -i, --apply-config               Import the reviewed candidate into D1
  -r, --expect-revision <number>   Remote revision from config review (0 if absent)
  -f, --expect-fingerprint <hash>  Candidate sha256 fingerprint from config review
  -h, --help                       Show this help

Environment required by --analytics or --apply-config:
  CLOUDFLARE_ACCOUNT_ID            32-character account identifier

Environment required by --apply-config:
  CLOUDFLARE_API_TOKEN             Token with D1 write access

Install ENDPOINT_MONITOR_HOOKRELAY_URL and ENDPOINT_MONITOR_HOOKRELAY_HMAC before enabling delivery, CLOUDFLARE_API_TOKEN before enabling analytics, and ENDPOINT_MONITOR_STATUS_TOKEN before enabling status. Apply migrations before --apply-config. A live --apply-config requires both review expectations and fails without overwriting a newer remote revision or changed candidate. Dry-run preparation does not read remote state and is not a configuration review.

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
    databaseName: "endpoint-monitor",
    delivery: false,
    dryRun: false,
    enabled: false,
    expectedFingerprint: null,
    expectedRevision: null,
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
    ["f", "expectedFingerprint"],
    ["N", "databaseName"],
    ["o", "outputPath"],
    ["p", "operatorProfilePath"],
    ["r", "expectedRevision"],
    ["s", "hookrelayService"],
    ["w", "workerName"],
  ])
  const longValues = new Map([
    ["--config", "configPath"],
    ["--database-id", "databaseId"],
    ["--database-name", "databaseName"],
    ["--expect-fingerprint", "expectedFingerprint"],
    ["--expect-revision", "expectedRevision"],
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
    ["i", "applyConfig"],
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
  if (options.expectedRevision !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(options.expectedRevision)) {
      throw new ConfigureError("--expect-revision must be a nonnegative integer")
    }
    options.expectedRevision = Number(options.expectedRevision)
  }
  if (options.applyConfig && !options.dryRun) {
    validateConfigurationExpectation(options.expectedRevision, options.expectedFingerprint)
  } else if (!options.applyConfig
    && (options.expectedRevision !== null || options.expectedFingerprint !== null)) {
    throw new ConfigureError("Review expectations require --apply-config")
  }
  if (!options.configPath) throw new ConfigureError("--config is required")
  if (!DATABASE_ID_PATTERN.test(options.databaseId || "")) {
    throw new ConfigureError("--database-id must be a lower-case UUID")
  }
  if (!SERVICE_NAME_PATTERN.test(options.databaseName)) {
    throw new ConfigureError("--database-name is invalid")
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
    return await configurationCandidate(candidate)
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

export function buildWranglerConfiguration(
  example,
  options,
  resolvedAccountId,
  assetPaths = {},
) {
  const migrationsPath = assetPaths.migrationsPath ?? PACKAGE_MIGRATIONS_PATH
  const workerPath = assetPaths.workerPath ?? PACKAGE_WORKER_PATH
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
      database_name: options.databaseName,
      migrations_dir: migrationsPath,
    })),
    main: workerPath,
    name: options.workerName,
    services: options.hookrelayService
      ? [{ binding: "HOOKRELAY", service: options.hookrelayService }]
      : [],
    vars,
  }
}

export async function applyConfiguration(
  fetchImpl,
  resolvedAccountId,
  apiToken,
  databaseId,
  loaded,
  updatedAt,
  expectations,
) {
  const operator = new CloudflareConfigurationOperator({
    accountId: resolvedAccountId, apiToken, databaseId, fetchImpl,
  })
  return operator.write(loaded.portable, { ...expectations, updatedAt })
}

function outputPlan(options, loaded, resolvedAccountId, applied = null) {
  return Object.freeze({
    analytics: options.analytics,
    applyConfig: options.applyConfig,
    applied: applied !== null,
    configFingerprint: loaded.configFingerprint,
    databaseId: options.databaseId,
    databaseName: options.databaseName,
    delivery: options.delivery,
    dryRun: options.dryRun,
    enabled: options.enabled,
    hookrelayService: options.hookrelayService,
    operatorProfilePath: options.operatorProfilePath,
    outputPath: path.resolve(options.outputPath),
    expectedRevision: options.expectedRevision,
    revision: applied?.revision ?? null,
    rowsWritten: applied?.rowsWritten ?? null,
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
  let applied = null
  if (options.applyConfig) {
    try {
      applied = await applyConfiguration(
        fetchImpl,
        resolvedAccountId,
        environment.CLOUDFLARE_API_TOKEN,
        options.databaseId,
        loaded,
        new Date(clock()).toISOString(),
        { expectedRevision: options.expectedRevision, expectedFingerprint: options.expectedFingerprint },
      )
    } catch (error) {
      writeLine(stderr, `endpoint-monitor: ${error.message}`)
      return error.exitCode || EXIT.RUNTIME
    }
  }
  writeLine(
    stdout,
    JSON.stringify(outputPlan(options, loaded, resolvedAccountId, applied)),
  )
  return EXIT.SUCCESS
}

export { EXIT, usage }
