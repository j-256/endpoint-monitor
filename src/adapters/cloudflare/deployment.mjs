import { spawn } from "node:child_process"
import { lstat } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"

import {
  applyConfiguration,
  runConfigure,
} from "../../../scripts/configure-cloudflare.mjs"
import {
  DEFAULT_PROFILE_PATH,
  loadOperatorProfile,
  loadOperatorTarget,
  loadOperatorWrangler,
  monitorDatabaseId,
  monitorDatabaseName,
  monitorWorkerName,
} from "../../operator.mjs"
import {
  PACKAGE_MIGRATIONS_PATH,
  PACKAGE_WORKER_PATH,
} from "../../project.mjs"

const require = createRequire(import.meta.url)
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/
const DATABASE_ID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const SERVICE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const API_ROOT = "https://api.cloudflare.com/client/v4"
const MONITOR_DATABASE_BINDING = "MONITOR_DB"
const HEALTH_ATTEMPTS = 6
const HEALTH_DELAYS_MS = Object.freeze([250, 500, 1000, 2000, 2000])
const FEATURE_VARIABLES = Object.freeze({
  analytics: "CLOUDFLARE_ANALYTICS_ENABLED",
  delivery: "ENDPOINT_MONITOR_DELIVERY_ENABLED",
  enabled: "ENDPOINT_MONITOR_ENABLED",
  status: "ENDPOINT_MONITOR_STATUS_ENABLED",
})
const EXIT = Object.freeze({
  MISSING_DEPENDENCY: 3,
  RUNTIME: 1,
  SUCCESS: 0,
  USAGE: 2,
})

class CloudflareDeploymentError extends Error {
  constructor(message, exitCode = EXIT.USAGE) {
    super(message)
    this.exitCode = exitCode
  }
}

function writeLine(stream, value) {
  stream.write(`${value}\n`)
}

function memoryStream() {
  let value = ""
  return Object.freeze({
    read: () => value,
    write: (chunk) => {
      value += chunk
    },
  })
}

function readOptionValue(argv, index, attached, name) {
  if (attached !== null) {
    if (!attached) throw new CloudflareDeploymentError(`${name} requires a value`)
    return { index, value: attached }
  }
  const value = argv[index + 1]
  if (value === undefined || value === "") {
    throw new CloudflareDeploymentError(`${name} requires a value`)
  }
  return { index: index + 1, value }
}

export function bootstrapUsage() {
  return `Usage: endpoint-monitor cloudflare bootstrap [options]

Create or adopt one D1 database, generate private package-resolved Wrangler
configuration, and apply the bundled migrations. Reruns reuse the recorded D1
binding and preserve existing feature selections.

Options:
  -p, --profile <path>            Operator profile (default: .endpoint-monitor.local.json)
  -d, --database-id <uuid>        Adopt an existing D1 database
  -N, --database-name <name>      D1 database name (default: endpoint-monitor)
  -w, --worker-name <name>        Worker name (default: endpoint-monitor)
  -s, --hookrelay-service <name>  Optional Hookrelay service binding target
  -a, --analytics                 Enable Cloudflare analytics enrichment
  -e, --enabled                   Enable scheduled monitoring
  -l, --delivery                  Enable Hookrelay delivery
  -t, --status                    Enable authenticated status output
  -n, --dry-run                   Validate and print the plan without writes
  -h, --help                      Show this help

Environment required for a live bootstrap:
  CLOUDFLARE_ACCOUNT_ID           32-character account identifier
  CLOUDFLARE_API_TOKEN            Token with D1 write access

Install required Worker secrets before deploying analytics, delivery, or status.
An interrupted migration is recoverable by rerunning the identical command.

Exit status:
  0  Bootstrap or dry-run succeeded
  1  Cloudflare, migration, or file operation failed
  2  Usage, environment, or operator project precondition is invalid
  3  Bundled Wrangler dependency is unavailable
`
}

export function parseBootstrapArguments(argv) {
  const options = {
    analytics: false,
    databaseId: null,
    databaseName: "endpoint-monitor",
    delivery: false,
    dryRun: false,
    enabled: false,
    help: false,
    hookrelayService: null,
    profilePath: DEFAULT_PROFILE_PATH,
    status: false,
    workerName: "endpoint-monitor",
  }
  const provided = new Set()
  const valueOptions = new Map([
    ["d", "databaseId"],
    ["N", "databaseName"],
    ["p", "profilePath"],
    ["s", "hookrelayService"],
    ["w", "workerName"],
  ])
  const longValues = new Map([
    ["--database-id", "databaseId"],
    ["--database-name", "databaseName"],
    ["--hookrelay-service", "hookrelayService"],
    ["--profile", "profilePath"],
    ["--worker-name", "workerName"],
  ])
  const flagOptions = new Map([
    ["a", "analytics"],
    ["e", "enabled"],
    ["h", "help"],
    ["l", "delivery"],
    ["n", "dryRun"],
    ["t", "status"],
  ])
  const longFlags = new Map([
    ["--analytics", "analytics"],
    ["--delivery", "delivery"],
    ["--dry-run", "dryRun"],
    ["--enabled", "enabled"],
    ["--help", "help"],
    ["--status", "status"],
  ])
  const positionals = []
  let endOfOptions = false
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
      if (longFlags.has(name)) {
        if (attached !== null) {
          throw new CloudflareDeploymentError(`${name} does not take a value`)
        }
        const option = longFlags.get(name)
        options[option] = true
        provided.add(option)
      } else if (longValues.has(name)) {
        const parsed = readOptionValue(argv, index, attached, name)
        const option = longValues.get(name)
        options[option] = parsed.value
        provided.add(option)
        index = parsed.index
      } else {
        throw new CloudflareDeploymentError(`Unknown option: ${name}`)
      }
      continue
    }
    let bundle = argument.slice(1)
    while (bundle) {
      const name = bundle[0]
      bundle = bundle.slice(1)
      if (flagOptions.has(name)) {
        const option = flagOptions.get(name)
        options[option] = true
        provided.add(option)
      } else if (valueOptions.has(name)) {
        const parsed = readOptionValue(argv, index, bundle || null, `-${name}`)
        const option = valueOptions.get(name)
        options[option] = parsed.value
        provided.add(option)
        index = parsed.index
        bundle = ""
      } else {
        throw new CloudflareDeploymentError(`Unknown option: -${name}`)
      }
    }
  }
  if (positionals.length > 0) {
    throw new CloudflareDeploymentError(`Unexpected argument: ${positionals[0]}`)
  }
  if (!options.help) {
    if (options.databaseId && !DATABASE_ID_PATTERN.test(options.databaseId)) {
      throw new CloudflareDeploymentError("--database-id must be a lower-case UUID")
    }
    for (const [name, value] of [
      ["--database-name", options.databaseName],
      ["--worker-name", options.workerName],
    ]) {
      if (!SERVICE_NAME_PATTERN.test(value)) {
        throw new CloudflareDeploymentError(`${name} is invalid`)
      }
    }
    if (options.hookrelayService
      && !SERVICE_NAME_PATTERN.test(options.hookrelayService)) {
      throw new CloudflareDeploymentError("--hookrelay-service is invalid")
    }
  }
  return Object.freeze({
    ...options,
    profilePath: path.resolve(options.profilePath),
    provided: Object.freeze(provided),
  })
}

export function deployUsage() {
  return `Usage: endpoint-monitor deploy [options]

Deploy the Worker and migrations bundled with this package version. A live run
applies pending migrations, synchronizes the active target document, deploys
the Worker, and verifies its workers.dev health endpoint.

Options:
  -p, --profile <path>  Operator profile (default: .endpoint-monitor.local.json)
  -n, --dry-run         Bundle and validate without provider or durable writes
  -h, --help            Show this help

Environment required for a live deployment:
  CLOUDFLARE_ACCOUNT_ID  32-character account identifier
  CLOUDFLARE_API_TOKEN   Token with D1 and Workers Scripts write access

Exit status:
  0  Deployment, health verification, or dry-run succeeded
  1  Migration, synchronization, deployment, or verification failed
  2  Usage, environment, or operator project precondition is invalid
  3  Bundled Wrangler dependency is unavailable
`
}

export function parseDeployArguments(argv) {
  const options = {
    dryRun: false,
    help: false,
    profilePath: DEFAULT_PROFILE_PATH,
  }
  const positionals = []
  let endOfOptions = false
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
      if (name === "--dry-run" || name === "--help") {
        if (attached !== null) {
          throw new CloudflareDeploymentError(`${name} does not take a value`)
        }
        options[name === "--help" ? "help" : "dryRun"] = true
      } else if (name === "--profile") {
        const parsed = readOptionValue(argv, index, attached, name)
        options.profilePath = parsed.value
        index = parsed.index
      } else {
        throw new CloudflareDeploymentError(`Unknown option: ${name}`)
      }
      continue
    }
    let bundle = argument.slice(1)
    while (bundle) {
      const name = bundle[0]
      bundle = bundle.slice(1)
      if (name === "h" || name === "n") {
        options[name === "h" ? "help" : "dryRun"] = true
      } else if (name === "p") {
        const parsed = readOptionValue(argv, index, bundle || null, "-p")
        options.profilePath = parsed.value
        index = parsed.index
        bundle = ""
      } else {
        throw new CloudflareDeploymentError(`Unknown option: -${name}`)
      }
    }
  }
  if (positionals.length > 0) {
    throw new CloudflareDeploymentError(`Unexpected argument: ${positionals[0]}`)
  }
  return Object.freeze({
    ...options,
    profilePath: path.resolve(options.profilePath),
  })
}

function cloudflareCredentials(environment) {
  const accountId = environment.CLOUDFLARE_ACCOUNT_ID
  const apiToken = environment.CLOUDFLARE_API_TOKEN
  if (!ACCOUNT_ID_PATTERN.test(accountId || "")) {
    throw new CloudflareDeploymentError(
      "CLOUDFLARE_ACCOUNT_ID is unavailable or invalid",
    )
  }
  if (typeof apiToken !== "string" || !apiToken) {
    throw new CloudflareDeploymentError("CLOUDFLARE_API_TOKEN is unavailable")
  }
  return Object.freeze({ accountId, apiToken })
}

async function cloudflareJsonRequest(
  fetchImpl,
  credentials,
  pathname,
  init,
  failureMessage,
) {
  let response
  try {
    response = await fetchImpl(`${API_ROOT}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${credentials.apiToken}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
    })
  } catch {
    throw new CloudflareDeploymentError(failureMessage, EXIT.RUNTIME)
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new CloudflareDeploymentError(failureMessage, EXIT.RUNTIME)
  }
  if (!response.ok || payload?.success !== true) {
    throw new CloudflareDeploymentError(failureMessage, EXIT.RUNTIME)
  }
  return payload.result
}

export async function createD1Database(fetchImpl, credentials, databaseName) {
  const result = await cloudflareJsonRequest(
    fetchImpl,
    credentials,
    `/accounts/${credentials.accountId}/d1/database`,
    {
      body: JSON.stringify({ name: databaseName }),
      method: "POST",
    },
    "Cloudflare D1 database creation failed",
  )
  if (!result
    || result.name !== databaseName
    || !DATABASE_ID_PATTERN.test(result.uuid || "")) {
    throw new CloudflareDeploymentError(
      "Cloudflare D1 database creation returned an invalid result",
      EXIT.RUNTIME,
    )
  }
  return Object.freeze({ id: result.uuid, name: result.name })
}

export async function accountWorkersSubdomain(fetchImpl, credentials) {
  const result = await cloudflareJsonRequest(
    fetchImpl,
    credentials,
    `/accounts/${credentials.accountId}/workers/subdomain`,
    { method: "GET" },
    "Cloudflare Workers subdomain lookup failed",
  )
  if (!result || !SUBDOMAIN_PATTERN.test(result.subdomain || "")) {
    throw new CloudflareDeploymentError(
      "Cloudflare Workers subdomain lookup returned an invalid result",
      EXIT.RUNTIME,
    )
  }
  return result.subdomain
}

export function resolveWranglerPath(resolveImpl = require.resolve) {
  let manifestPath
  try {
    manifestPath = resolveImpl("wrangler/package.json")
  } catch {
    throw new CloudflareDeploymentError(
      "Bundled Wrangler dependency is unavailable",
      EXIT.MISSING_DEPENDENCY,
    )
  }
  return path.join(path.dirname(manifestPath), "bin", "wrangler.js")
}

export async function executeWrangler(
  argumentsList,
  {
    cwd = process.cwd(),
    environment = process.env,
    spawnImpl = spawn,
    wranglerPath = resolveWranglerPath(),
  } = {},
) {
  let child
  try {
    child = spawnImpl(process.execPath, [wranglerPath, ...argumentsList], {
      cwd,
      env: environment,
      stdio: "inherit",
    })
  } catch {
    throw new CloudflareDeploymentError(
      "Bundled Wrangler dependency is unavailable",
      EXIT.MISSING_DEPENDENCY,
    )
  }
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code, signal) => resolve({ code, signal }))
  }).catch((error) => {
    throw new CloudflareDeploymentError(
      error?.code === "ENOENT"
        ? "Bundled Wrangler dependency is unavailable"
        : "Wrangler execution failed",
      error?.code === "ENOENT" ? EXIT.MISSING_DEPENDENCY : EXIT.RUNTIME,
    )
  })
  if (status.code !== 0) {
    throw new CloudflareDeploymentError(
      `Wrangler exited with status ${status.code ?? status.signal ?? "unknown"}`,
      EXIT.RUNTIME,
    )
  }
}

function deploymentDependencies(overrides = {}) {
  return {
    clock: Date.now,
    environment: process.env,
    fetchImpl: globalThis.fetch,
    lstatImpl: lstat,
    readFileImpl: undefined,
    runConfigureImpl: runConfigure,
    runWranglerImpl: null,
    sleepImpl: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    stderr: process.stderr,
    stdout: process.stdout,
    ...overrides,
  }
}

function operatorOverrides(dependencies) {
  return Object.fromEntries(
    ["lstatImpl", "readFileImpl"]
      .filter((name) => typeof dependencies[name] === "function")
      .map((name) => [name, dependencies[name]]),
  )
}

async function optionalWrangler(profile, dependencies) {
  const overrides = operatorOverrides(dependencies)
  try {
    await dependencies.lstatImpl(profile.wranglerPath)
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw new CloudflareDeploymentError("Cannot inspect Wrangler configuration")
  }
  return loadOperatorWrangler(profile, overrides)
}

function configuredFeature(wrangler, option) {
  const value = wrangler?.vars?.[FEATURE_VARIABLES[option]]
  if (!["true", "false"].includes(value)) {
    throw new CloudflareDeploymentError(
      `Wrangler configuration has an invalid ${FEATURE_VARIABLES[option]} value`,
    )
  }
  return value === "true"
}

function configuredHookrelayService(wrangler) {
  const binding = wrangler?.services?.find((entry) => entry.binding === "HOOKRELAY")
  if (!binding) return null
  if (!SERVICE_NAME_PATTERN.test(binding.service || "")) {
    throw new CloudflareDeploymentError(
      "Wrangler configuration has an invalid HOOKRELAY service binding",
    )
  }
  return binding.service
}

function resolveBootstrapOptions(options, existingWrangler) {
  const resolved = { ...options }
  if (!existingWrangler) {
    return Object.freeze({
      ...resolved,
      databaseAction: resolved.databaseId ? "adopt" : "create",
    })
  }
  const existingDatabaseId = monitorDatabaseId(existingWrangler)
  const existingDatabaseName = monitorDatabaseName(existingWrangler)
  if (options.databaseId && options.databaseId !== existingDatabaseId) {
    throw new CloudflareDeploymentError(
      "--database-id does not match the recorded MONITOR_DB binding",
    )
  }
  if (options.provided.has("databaseName")
    && options.databaseName !== existingDatabaseName) {
    throw new CloudflareDeploymentError(
      "--database-name does not match the recorded MONITOR_DB binding",
    )
  }
  resolved.databaseId = existingDatabaseId
  resolved.databaseName = existingDatabaseName
  if (!options.provided.has("workerName")) {
    resolved.workerName = monitorWorkerName(existingWrangler)
  }
  for (const option of Object.keys(FEATURE_VARIABLES)) {
    if (!options.provided.has(option)) {
      resolved[option] = configuredFeature(existingWrangler, option)
    }
  }
  if (!options.provided.has("hookrelayService")) {
    resolved.hookrelayService = configuredHookrelayService(existingWrangler)
  }
  return Object.freeze({ ...resolved, databaseAction: "reuse" })
}

function bootstrapPlan(options, loaded, profile) {
  return Object.freeze({
    analytics: options.analytics,
    databaseAction: options.databaseAction,
    databaseId: options.databaseAction === "create" ? null : options.databaseId,
    databaseName: options.databaseName,
    delivery: options.delivery,
    dryRun: options.dryRun,
    enabled: options.enabled,
    hookrelayService: options.hookrelayService,
    migrationsPath: PACKAGE_MIGRATIONS_PATH,
    profilePath: options.profilePath,
    status: options.status,
    targetCount: loaded.portable.targets.length,
    workerName: options.workerName,
    workerPath: PACKAGE_WORKER_PATH,
    wranglerPath: profile.wranglerPath,
  })
}

function configureArguments(options, profile, databaseId) {
  const argv = [
    "--config",
    profile.configPath,
    "--database-id",
    databaseId,
    "--database-name",
    options.databaseName,
    "--output",
    profile.wranglerPath,
    "--operator-profile",
    options.profilePath,
    "--worker-name",
    options.workerName,
  ]
  for (const option of ["analytics", "delivery", "enabled", "status"]) {
    if (options[option]) argv.push(`--${option}`)
  }
  if (options.hookrelayService) {
    argv.push("--hookrelay-service", options.hookrelayService)
  }
  return argv
}

async function configureBootstrap(options, profile, databaseId, dependencies) {
  const stdout = memoryStream()
  const stderr = memoryStream()
  const status = await dependencies.runConfigureImpl(
    configureArguments(options, profile, databaseId),
    { ...dependencies, stderr, stdout },
  )
  if (status !== EXIT.SUCCESS) {
    const message = stderr.read().trim().replace(/^endpoint-monitor:\s*/, "")
    throw new CloudflareDeploymentError(
      message || "Cannot write Cloudflare operator configuration",
      status === EXIT.USAGE ? EXIT.USAGE : EXIT.RUNTIME,
    )
  }
}

async function runWrangler(argumentsList, cwd, dependencies) {
  if (dependencies.runWranglerImpl) {
    await dependencies.runWranglerImpl(argumentsList, { cwd })
    return
  }
  await executeWrangler(argumentsList, {
    cwd,
    environment: dependencies.environment,
  })
}

export async function runBootstrap(argv, overrides = {}) {
  const dependencies = deploymentDependencies(overrides)
  let options
  try {
    options = parseBootstrapArguments(argv)
  } catch (error) {
    writeLine(dependencies.stderr, `endpoint-monitor: ${error.message}`)
    return error.exitCode || EXIT.USAGE
  }
  if (options.help) {
    dependencies.stdout.write(bootstrapUsage())
    return EXIT.SUCCESS
  }
  try {
    const operatorDeps = operatorOverrides(dependencies)
    const { loaded, profile } = await loadOperatorTarget(
      options.profilePath,
      operatorDeps,
    )
    const existingWrangler = await optionalWrangler(profile, dependencies)
    const resolved = resolveBootstrapOptions(options, existingWrangler)
    const plan = bootstrapPlan(resolved, loaded, profile)
    if (resolved.dryRun) {
      writeLine(dependencies.stdout, JSON.stringify(plan))
      return EXIT.SUCCESS
    }
    const credentials = cloudflareCredentials(dependencies.environment)
    const database = resolved.databaseAction === "create"
      ? await createD1Database(
        dependencies.fetchImpl,
        credentials,
        resolved.databaseName,
      )
      : { id: resolved.databaseId, name: resolved.databaseName }
    await configureBootstrap(resolved, profile, database.id, dependencies)
    await runWrangler([
      "d1",
      "migrations",
      "apply",
      MONITOR_DATABASE_BINDING,
      "--remote",
      "--config",
      profile.wranglerPath,
    ], path.dirname(profile.wranglerPath), dependencies)
    writeLine(
      dependencies.stdout,
      `${resolved.databaseAction === "create" ? "Created" : "Using"} D1 database ${database.name}; bundled migrations are applied`,
    )
    return EXIT.SUCCESS
  } catch (error) {
    writeLine(dependencies.stderr, `endpoint-monitor: ${error.message}`)
    return error.exitCode || EXIT.RUNTIME
  }
}

function validatePackageResolvedWrangler(wrangler) {
  const binding = wrangler?.d1_databases?.find((entry) => entry.binding === "MONITOR_DB")
  if (path.resolve(wrangler?.main || "") !== PACKAGE_WORKER_PATH
    || path.resolve(binding?.migrations_dir || "") !== PACKAGE_MIGRATIONS_PATH) {
    throw new CloudflareDeploymentError(
      "Wrangler configuration does not reference this package version; rerun cloudflare bootstrap",
    )
  }
  if (wrangler.workers_dev !== true) {
    throw new CloudflareDeploymentError(
      "Wrangler configuration must enable workers.dev for health verification",
    )
  }
}

export async function verifyWorkerHealth(
  fetchImpl,
  url,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: "application/json" },
        method: "GET",
        redirect: "error",
      })
      const payload = await response.json()
      if (response.ok
        && payload?.ok === true
        && payload?.service === "endpoint-monitor") {
        return true
      }
    } catch {}
    if (attempt < HEALTH_DELAYS_MS.length) {
      await sleepImpl(HEALTH_DELAYS_MS[attempt])
    }
  }
  throw new CloudflareDeploymentError(
    "Deployed Worker health verification failed",
    EXIT.RUNTIME,
  )
}

export async function runDeploy(argv, overrides = {}) {
  const dependencies = deploymentDependencies(overrides)
  let options
  try {
    options = parseDeployArguments(argv)
  } catch (error) {
    writeLine(dependencies.stderr, `endpoint-monitor: ${error.message}`)
    return error.exitCode || EXIT.USAGE
  }
  if (options.help) {
    dependencies.stdout.write(deployUsage())
    return EXIT.SUCCESS
  }
  try {
    const operatorDeps = operatorOverrides(dependencies)
    const { loaded, profile } = await loadOperatorTarget(
      options.profilePath,
      operatorDeps,
    )
    const wrangler = await loadOperatorWrangler(profile, operatorDeps)
    validatePackageResolvedWrangler(wrangler)
    const databaseId = monitorDatabaseId(wrangler)
    monitorDatabaseName(wrangler)
    const workerName = monitorWorkerName(wrangler)
    const cwd = path.dirname(profile.wranglerPath)
    if (options.dryRun) {
      await runWrangler([
        "deploy",
        "--dry-run",
        "--config",
        profile.wranglerPath,
      ], cwd, dependencies)
      writeLine(
        dependencies.stdout,
        `Deployment dry run passed for ${workerName} with ${loaded.portable.targets.length} target(s)`,
      )
      return EXIT.SUCCESS
    }
    const credentials = cloudflareCredentials(dependencies.environment)
    await runWrangler([
      "d1",
      "migrations",
      "apply",
      MONITOR_DATABASE_BINDING,
      "--remote",
      "--config",
      profile.wranglerPath,
    ], cwd, dependencies)
    const rowsWritten = await applyConfiguration(
      dependencies.fetchImpl,
      credentials.accountId,
      credentials.apiToken,
      databaseId,
      loaded,
      new Date(dependencies.clock()).toISOString(),
    )
    await runWrangler([
      "deploy",
      "--config",
      profile.wranglerPath,
    ], cwd, dependencies)
    const subdomain = await accountWorkersSubdomain(
      dependencies.fetchImpl,
      credentials,
    )
    const healthUrl = `https://${workerName}.${subdomain}.workers.dev/healthz`
    await verifyWorkerHealth(
      dependencies.fetchImpl,
      healthUrl,
      dependencies.sleepImpl,
    )
    writeLine(
      dependencies.stdout,
      `Deployed ${workerName} with ${loaded.portable.targets.length} target(s); D1 rows written: ${rowsWritten}; health: ${healthUrl}`,
    )
    return EXIT.SUCCESS
  } catch (error) {
    writeLine(dependencies.stderr, `endpoint-monitor: ${error.message}`)
    return error.exitCode || EXIT.RUNTIME
  }
}

export {
  CloudflareDeploymentError,
  EXIT,
  FEATURE_VARIABLES,
  MONITOR_DATABASE_BINDING,
}
