#!/usr/bin/env node

import { readFile } from "node:fs/promises"

import {
  configuredTargets,
  normalizeConfiguration,
  portableConfiguration,
} from "./config.mjs"
import { isMainModule } from "./main-module.mjs"
import { probeTargets, summarizeProbeResults } from "./probe.mjs"

const EXIT = Object.freeze({
  MISSING_DEPENDENCY: 3,
  RUNTIME: 1,
  SUCCESS: 0,
  USAGE: 2,
})
const COMMANDS = new Set(["normalize", "probe", "validate"])
const MAXIMUM_CLI_CONCURRENCY = 20

class CliError extends Error {
  constructor(message, exitCode = EXIT.USAGE) {
    super(message)
    this.exitCode = exitCode
  }
}

function help(command = null) {
  if (command === "validate") return `Usage: endpoint-monitor validate [--json] <config-file>

Validate an Endpoint Monitor JSON document without probing targets.

Options:
  -j, --json  Write the result as JSON
  -h, --help  Show this help
`
  if (command === "normalize") return `Usage: endpoint-monitor normalize <config-file>

Write the fully resolved portable configuration as JSON.

Options:
  -h, --help  Show this help
`
  if (command === "probe") return `Usage: endpoint-monitor probe [--json] [--concurrency <count>] <config-file>

Probe every configured target once without persistence or delivery.

Options:
  -c, --concurrency <count>  Concurrent probes from 1 through ${MAXIMUM_CLI_CONCURRENCY} (default: 5)
  -j, --json                 Write the result as JSON
  -h, --help                 Show this help

Exit status:
  0  Every probe succeeded
  1  A probe failed or a runtime operation failed
  2  Usage, file, or configuration error
  3  Required dependency unavailable
`
  return `Usage: endpoint-monitor <command> [options] <config-file>

Validate, normalize, or probe an explicit Endpoint Monitor target document.

Commands:
  validate   Validate configuration without network access
  normalize  Write resolved configuration as JSON
  probe      Probe every target once without persistence or delivery

Global options:
  -h, --help  Show help

Run endpoint-monitor <command> --help for command options. Configuration must be JSON with schemaVersion 1, optional defaults, and a targets array. Target entries require id and an absolute public HTTP or HTTPS url. Exit statuses are 0 for success, 1 for runtime or probe failure, 2 for usage or configuration errors, and 3 for missing dependencies.
`
}

function optionValue(argv, index, attached, label) {
  if (attached !== null) {
    if (!attached) throw new CliError(`${label} requires a value`)
    return { index, value: attached }
  }
  const value = argv[index + 1]
  if (value === undefined || value === "") {
    throw new CliError(`${label} requires a value`)
  }
  return { index: index + 1, value }
}

export function parseCliArguments(argv) {
  const options = { concurrency: 5, help: false, json: false }
  const positionals = []
  let passthrough = false
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
      if (name === "--help") {
        if (attached !== null) throw new CliError("--help does not take a value")
        options.help = true
      } else if (name === "--json") {
        if (attached !== null) throw new CliError("--json does not take a value")
        options.json = true
      } else if (name === "--concurrency") {
        const parsed = optionValue(argv, index, attached, "--concurrency")
        options.concurrency = Number(parsed.value)
        index = parsed.index
      } else {
        throw new CliError(`Unknown option: ${name}`)
      }
      continue
    }
    let bundle = argument.slice(1)
    while (bundle) {
      const name = bundle[0]
      bundle = bundle.slice(1)
      if (name === "h") options.help = true
      else if (name === "j") options.json = true
      else if (name === "c") {
        const parsed = optionValue(
          argv,
          index,
          bundle || null,
          "-c",
        )
        options.concurrency = Number(parsed.value)
        index = parsed.index
        bundle = ""
      } else {
        throw new CliError(`Unknown option: -${name}`)
      }
    }
  }
  if (!Number.isInteger(options.concurrency)
    || options.concurrency < 1
    || options.concurrency > MAXIMUM_CLI_CONCURRENCY) {
    throw new CliError(
      `Concurrency must be an integer from 1 through ${MAXIMUM_CLI_CONCURRENCY}`,
    )
  }
  const command = positionals[0] === "help" ? positionals[1] : positionals[0]
  const helpRequested = options.help || positionals[0] === "help"
  if (helpRequested) {
    if (command && !COMMANDS.has(command)) {
      throw new CliError(`Unknown command: ${command}`)
    }
    return Object.freeze({ command: command || null, help: true, options })
  }
  if (!command) throw new CliError("A command is required")
  if (!COMMANDS.has(command)) throw new CliError(`Unknown command: ${command}`)
  if (positionals.length !== 2) {
    throw new CliError(`${command} requires exactly one configuration file`)
  }
  if (command !== "probe" && options.concurrency !== 5) {
    throw new CliError("--concurrency is valid only with probe")
  }
  if (command === "normalize" && options.json) {
    throw new CliError("normalize always writes JSON and does not accept --json")
  }
  return Object.freeze({
    command,
    configPath: positionals[1],
    help: false,
    options: Object.freeze(options),
  })
}

async function readConfiguration(configPath, readFileImpl) {
  let source
  try {
    source = await readFileImpl(configPath, "utf8")
  } catch {
    throw new CliError(`Cannot read configuration: ${configPath}`)
  }
  let candidate
  try {
    candidate = JSON.parse(source)
  } catch {
    throw new CliError(`Configuration is not valid JSON: ${configPath}`)
  }
  try {
    return Object.freeze({
      candidate,
      normalized: normalizeConfiguration(candidate),
    })
  } catch (error) {
    throw new CliError(error.message)
  }
}

function writeLine(stream, value) {
  stream.write(`${value}\n`)
}

function probeResult(entry) {
  return Object.freeze({
    errorCode: entry.observation.errorCode,
    httpStatus: entry.observation.httpStatus,
    observedAt: entry.observation.observedAt,
    outcome: entry.observation.outcome,
    targetId: entry.target.id,
  })
}

export async function runCli(
  argv,
  {
    clock = Date.now,
    fetchImpl = globalThis.fetch,
    readFileImpl = readFile,
    stderr = process.stderr,
    stdout = process.stdout,
  } = {},
) {
  let parsed
  try {
    parsed = parseCliArguments(argv)
  } catch (error) {
    writeLine(stderr, `endpoint-monitor: ${error.message}`)
    return error.exitCode || EXIT.USAGE
  }
  if (parsed.help) {
    stdout.write(help(parsed.command))
    return EXIT.SUCCESS
  }
  let loaded
  try {
    loaded = await readConfiguration(parsed.configPath, readFileImpl)
  } catch (error) {
    writeLine(stderr, `endpoint-monitor: ${error.message}`)
    return error.exitCode || EXIT.USAGE
  }
  if (parsed.command === "validate") {
    writeLine(
      stdout,
      parsed.options.json
        ? JSON.stringify({
          targetCount: loaded.normalized.targets.length,
          valid: true,
        })
        : `Valid configuration with ${loaded.normalized.targets.length} target(s)`,
    )
    return EXIT.SUCCESS
  }
  if (parsed.command === "normalize") {
    writeLine(stdout, JSON.stringify(portableConfiguration(loaded.candidate), null, 2))
    return EXIT.SUCCESS
  }
  let targets
  let results
  try {
    targets = await configuredTargets(loaded.candidate)
    const observedAt = new Date(clock()).toISOString()
    results = await probeTargets(
      fetchImpl,
      targets,
      observedAt,
      parsed.options.concurrency,
    )
  } catch {
    writeLine(stderr, "endpoint-monitor: Probe execution failed")
    return EXIT.RUNTIME
  }
  const summary = summarizeProbeResults(results)
  const output = results.map(probeResult)
  if (parsed.options.json) {
    writeLine(stdout, JSON.stringify({ results: output, summary }))
  } else {
    for (const result of output) {
      const detail = result.httpStatus === null
        ? result.errorCode
        : `HTTP ${result.httpStatus}`
      writeLine(
        stdout,
        `${result.outcome === "success" ? "OK" : "FAIL"} ${result.targetId} ${detail}`,
      )
    }
    writeLine(
      stdout,
      `${summary.succeeded} succeeded, ${summary.failed} failed`,
    )
  }
  return summary.failed > 0 ? EXIT.RUNTIME : EXIT.SUCCESS
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2))
}

export { EXIT, help }
