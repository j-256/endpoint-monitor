#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises"
import path from "node:path"

import {
  applyConfiguration,
  runConfigure,
  usage as cloudflareConfigureHelp,
} from "../scripts/configure-cloudflare.mjs"
import { configuredTargets } from "./config.mjs"
import { isMainModule } from "./main-module.mjs"
import {
  DEFAULT_PROFILE_PATH,
  loadOperatorProfile,
  loadOperatorTarget,
  loadOperatorWrangler,
  loadTargetDocument,
  monitorDatabaseId,
} from "./operator.mjs"
import { probeTargets, summarizeProbeResults } from "./probe.mjs"
import {
  CloudflareIncidentOperator,
  INCIDENT_LIST_LIMIT,
} from "./adapters/cloudflare/operator-incidents.mjs"
import { INCIDENT_ACTION } from "./constants.mjs"

const EXIT = Object.freeze({
  MISSING_DEPENDENCY: 3,
  RUNTIME: 1,
  SUCCESS: 0,
  USAGE: 2,
})
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/
const COMMAND = Object.freeze({
  CLOUDFLARE_CONFIGURE: "cloudflare.configure",
  CONFIG_PATH: "config.path",
  CONFIG_SHOW: "config.show",
  CONFIG_SYNC: "config.sync",
  CONFIG_VALIDATE: "config.validate",
  INCIDENTS_ACKNOWLEDGE: "incidents.acknowledge",
  INCIDENTS_DISMISS: "incidents.dismiss",
  INCIDENTS_LIST: "incidents.list",
  INCIDENTS_SHOW: "incidents.show",
  INCIDENTS_SNOOZE: "incidents.snooze",
  PROBE: "probe",
  TARGETS: "targets",
})
const CONFIG_COMMANDS = new Map([
  ["path", COMMAND.CONFIG_PATH],
  ["show", COMMAND.CONFIG_SHOW],
  ["sync", COMMAND.CONFIG_SYNC],
  ["validate", COMMAND.CONFIG_VALIDATE],
])
const INCIDENT_COMMANDS = new Map([
  ["acknowledge", COMMAND.INCIDENTS_ACKNOWLEDGE],
  ["dismiss", COMMAND.INCIDENTS_DISMISS],
  ["list", COMMAND.INCIDENTS_LIST],
  ["show", COMMAND.INCIDENTS_SHOW],
  ["snooze", COMMAND.INCIDENTS_SNOOZE],
])
const INCIDENT_COMMAND_SET = new Set(INCIDENT_COMMANDS.values())
const INCIDENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/
const HELP_ROUTES = new Set([
  "",
  "cloudflare",
  "cloudflare configure",
  "config",
  "config path",
  "config show",
  "config sync",
  "config validate",
  "incidents",
  "incidents acknowledge",
  "incidents dismiss",
  "incidents list",
  "incidents show",
  "incidents snooze",
  "probe",
  "targets",
])
const JSON_COMMANDS = new Set([
  COMMAND.CONFIG_PATH,
  COMMAND.CONFIG_SYNC,
  COMMAND.CONFIG_VALIDATE,
  COMMAND.INCIDENTS_ACKNOWLEDGE,
  COMMAND.INCIDENTS_DISMISS,
  COMMAND.INCIDENTS_LIST,
  COMMAND.INCIDENTS_SHOW,
  COMMAND.INCIDENTS_SNOOZE,
  COMMAND.PROBE,
  COMMAND.TARGETS,
])
const MAXIMUM_CLI_CONCURRENCY = 20
const PROFILE_COMMANDS = new Set([
  COMMAND.CONFIG_PATH,
  COMMAND.CONFIG_SHOW,
  COMMAND.CONFIG_SYNC,
  COMMAND.CONFIG_VALIDATE,
  COMMAND.INCIDENTS_ACKNOWLEDGE,
  COMMAND.INCIDENTS_DISMISS,
  COMMAND.INCIDENTS_LIST,
  COMMAND.INCIDENTS_SHOW,
  COMMAND.INCIDENTS_SNOOZE,
  COMMAND.PROBE,
  COMMAND.TARGETS,
])
const OPERATOR_PROFILE_HELP = "The mode-0600 operator profile is created by endpoint-monitor cloudflare configure and names the active target document and generated Wrangler configuration."
const TARGET_DOCUMENT_HELP = "Target documents are JSON with schemaVersion 1 or 2, optional defaults, and a targets array. Each target requires a lower-case DNS-style id and an absolute public HTTP or HTTPS url."
const INCIDENT_READ_ENVIRONMENT_HELP = `Environment:
  CLOUDFLARE_ACCOUNT_ID  32-character account identifier
  CLOUDFLARE_API_TOKEN   Token with D1 read access`
const INCIDENT_WRITE_ENVIRONMENT_HELP = `Environment:
  CLOUDFLARE_ACCOUNT_ID  32-character account identifier
  CLOUDFLARE_API_TOKEN   Token with D1 write access`

class CliError extends Error {
  constructor(message, exitCode = EXIT.USAGE) {
    super(message)
    this.exitCode = exitCode
  }
}

function help(route = []) {
  const key = route.join(" ")
  if (key === "config") return `Usage: endpoint-monitor config <command> [options]

Inspect, validate, or synchronize the active target document.

${TARGET_DOCUMENT_HELP}

${OPERATOR_PROFILE_HELP}

Commands:
  path      Show the active target document path
  show      Show the fully resolved target document
  validate  Validate the target document without network access
  sync      Idempotently store the active target document in D1

Run endpoint-monitor help config <command> for command options.
`
  if (key === "config path") return `Usage: endpoint-monitor config path [--json] [--profile <path>]

Show the active target document path from the local operator profile.

${OPERATOR_PROFILE_HELP}

Options:
  -j, --json            Write machine-readable output
  -p, --profile <path>  Operator profile (default: .endpoint-monitor.local.json)
  -h, --help            Show this help
`
  if (key === "config show") return `Usage: endpoint-monitor config show [--profile <path>] [<target-document>]

Write the fully resolved portable target document as JSON. When no target document is supplied, use the one named by the local operator profile.

${TARGET_DOCUMENT_HELP}

${OPERATOR_PROFILE_HELP}

Options:
  -p, --profile <path>  Operator profile (default: .endpoint-monitor.local.json)
  -h, --help            Show this help
`
  if (key === "config validate") return `Usage: endpoint-monitor config validate [--json] [--profile <path>] [<target-document>]

Validate a target document without network access. When no target document is supplied, use the one named by the local operator profile.

${TARGET_DOCUMENT_HELP}

${OPERATOR_PROFILE_HELP}

Options:
  -j, --json            Write machine-readable output
  -p, --profile <path>  Operator profile (default: .endpoint-monitor.local.json)
  -h, --help            Show this help
`
  if (key === "config sync") return `Usage: endpoint-monitor config sync [--json] [--profile <path>]

Validate and idempotently store the active target document in the D1 database identified by the generated Wrangler configuration.

${TARGET_DOCUMENT_HELP}

${OPERATOR_PROFILE_HELP}

Options:
  -j, --json            Write machine-readable output
  -p, --profile <path>  Operator profile (default: .endpoint-monitor.local.json)
  -h, --help            Show this help

Environment:
  CLOUDFLARE_ACCOUNT_ID  32-character account identifier
  CLOUDFLARE_API_TOKEN   Token with D1 write access
`
  if (key === "targets") return `Usage: endpoint-monitor targets [--json] [--profile <path>]

List IDs, methods, status contracts, and URLs from the active target document.

${TARGET_DOCUMENT_HELP}

${OPERATOR_PROFILE_HELP}

Options:
  -j, --json            Write machine-readable output
  -p, --profile <path>  Operator profile (default: .endpoint-monitor.local.json)
  -h, --help            Show this help
`
  if (key === "probe") return `Usage: endpoint-monitor probe [--json] [--profile <path>] [--concurrency <count>] [<target-document>]

Probe every target once without persistence or delivery. When no target document is supplied, use the one named by the local operator profile.

${TARGET_DOCUMENT_HELP}

${OPERATOR_PROFILE_HELP}

Options:
  -c, --concurrency <count>  Concurrent probes from 1 through ${MAXIMUM_CLI_CONCURRENCY} (default: 5)
  -j, --json                 Write machine-readable output
  -p, --profile <path>       Operator profile (default: .endpoint-monitor.local.json)
  -h, --help                 Show this help

Exit status:
  0  Every probe succeeded
  1  A probe or runtime operation failed
  2  Usage, file, or configuration error
  3  Required dependency unavailable
`
  if (key === "incidents") return `Usage: endpoint-monitor incidents <command> [options]

View and triage incidents in the D1 database identified by the local operator profile.

${OPERATOR_PROFILE_HELP}

Commands:
  list         List open or recent incidents
  show         Show one incident and its triage history
  acknowledge  Record that an open incident was reviewed
  snooze       Delay a pending problem delivery
  dismiss      Resolve an incident and clear its exceptional state

Run endpoint-monitor help incidents <command> for command options.
`
  if (key === "incidents list") return `Usage: endpoint-monitor incidents list [--all] [--limit <count>] [--json] [--profile <path>]

List open incidents by default. Include resolved incident history with --all.

${OPERATOR_PROFILE_HELP}

Options:
  -a, --all             Include resolved incidents
  -l, --limit <count>   Return 1 through ${INCIDENT_LIST_LIMIT.maximum} incidents (default: ${INCIDENT_LIST_LIMIT.default})
  -j, --json            Write machine-readable output
  -p, --profile <path>  Operator profile (default: .endpoint-monitor.local.json)
  -h, --help            Show this help

${INCIDENT_READ_ENVIRONMENT_HELP}
`
  if (key === "incidents show") return `Usage: endpoint-monitor incidents show <incident-id> [--json] [--profile <path>]

Show one incident and its ordered acknowledgement, snooze, and dismissal history.

${OPERATOR_PROFILE_HELP}

Options:
  -j, --json            Write machine-readable output
  -p, --profile <path>  Operator profile (default: .endpoint-monitor.local.json)
  -h, --help            Show this help

${INCIDENT_READ_ENVIRONMENT_HELP}
`
  if (key === "incidents acknowledge") return `Usage: endpoint-monitor incidents acknowledge <incident-id> [--note <text>] [--json] [--profile <path>]

Record that an open incident was reviewed without changing health or delivery state.

${OPERATOR_PROFILE_HELP}

Options:
  -n, --note <text>     Optional bounded operator note
  -j, --json            Write machine-readable output
  -p, --profile <path>  Operator profile (default: .endpoint-monitor.local.json)
  -h, --help            Show this help

${INCIDENT_WRITE_ENVIRONMENT_HELP}
`
  if (key === "incidents snooze") return `Usage: endpoint-monitor incidents snooze <incident-id> --until <timestamp> [--note <text>] [--json] [--profile <path>]

Record a snooze and delay an undelivered problem transition until a future RFC 3339 timestamp. Probes and already-delivered transitions are unaffected.

${OPERATOR_PROFILE_HELP}

Options:
  -u, --until <timestamp>  Future RFC 3339 snooze deadline
  -n, --note <text>        Optional bounded operator note
  -j, --json               Write machine-readable output
  -p, --profile <path>     Operator profile (default: .endpoint-monitor.local.json)
  -h, --help               Show this help

${INCIDENT_WRITE_ENVIRONMENT_HELP}
`
  if (key === "incidents dismiss") return `Usage: endpoint-monitor incidents dismiss <incident-id> [--note <text>] [--json] [--profile <path>]

Resolve an open incident as operator-dismissed and clear its exceptional target state. A continuing failure can reopen after its normal threshold.

${OPERATOR_PROFILE_HELP}

Options:
  -n, --note <text>     Optional bounded operator note
  -j, --json            Write machine-readable output
  -p, --profile <path>  Operator profile (default: .endpoint-monitor.local.json)
  -h, --help            Show this help

${INCIDENT_WRITE_ENVIRONMENT_HELP}
`
  if (key === "cloudflare") return `Usage: endpoint-monitor cloudflare <command> [options]

Prepare and operate the Cloudflare adapter.

Commands:
  configure  Prepare Wrangler and the local operator profile

Run endpoint-monitor help cloudflare configure for command options.
`
  if (key === "cloudflare configure") return cloudflareConfigureHelp()
  return `Usage: endpoint-monitor <command> [options]

Operate explicit Endpoint Monitor target documents and provider adapters.

${TARGET_DOCUMENT_HELP}

${OPERATOR_PROFILE_HELP}

Commands:
  config <command>       Inspect, validate, or synchronize the target document
  incidents <command>    View or triage durable incidents
  targets                List the active configured targets
  probe [<file>]         Probe the active or supplied target document once
  cloudflare configure   Prepare the Cloudflare adapter
  help [command ...]     Show command help

Options:
  -h, --help             Show this help

Run endpoint-monitor help <command> for command options.

Exit status:
  0  Command succeeded
  1  Probe or provider operation failed
  2  Usage, file, or configuration error
  3  Required dependency unavailable
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

function helpRoute(positionals) {
  const requested = positionals[0] === "help"
    ? positionals.slice(1)
    : positionals
  let route
  if (requested.length === 0) route = []
  else if (requested[0] === "config") route = requested.slice(0, 2)
  else if (requested[0] === "cloudflare") route = requested.slice(0, 2)
  else if (requested[0] === "incidents") route = requested.slice(0, 2)
  else route = requested.slice(0, 1)
  const key = route.join(" ")
  if (!HELP_ROUTES.has(key)) {
    throw new CliError(`Unknown command: ${requested.join(" ")}`)
  }
  if (positionals[0] === "help" && requested.length !== route.length) {
    throw new CliError(`Unexpected argument: ${requested[route.length]}`)
  }
  return route
}

function commandFromPositionals(positionals) {
  if (positionals.length === 0) throw new CliError("A command is required")
  if (positionals[0] === "config") {
    if (positionals.length === 1) throw new CliError("config requires a subcommand")
    if (!CONFIG_COMMANDS.has(positionals[1])) {
      throw new CliError(`Unknown command: config ${positionals[1]}`)
    }
    const command = CONFIG_COMMANDS.get(positionals[1])
    const acceptsDocument = command === COMMAND.CONFIG_SHOW
      || command === COMMAND.CONFIG_VALIDATE
    const maximumPositionals = acceptsDocument ? 3 : 2
    if (positionals.length > maximumPositionals) {
      throw new CliError(`Unexpected argument: ${positionals[maximumPositionals]}`)
    }
    return { command, configPath: positionals[2] ?? null }
  }
  if (positionals[0] === "targets") {
    if (positionals.length > 1) {
      throw new CliError(`Unexpected argument: ${positionals[1]}`)
    }
    return { command: COMMAND.TARGETS, configPath: null }
  }
  if (positionals[0] === "incidents") {
    if (positionals.length === 1) throw new CliError("incidents requires a subcommand")
    if (!INCIDENT_COMMANDS.has(positionals[1])) {
      throw new CliError(`Unknown command: incidents ${positionals[1]}`)
    }
    const command = INCIDENT_COMMANDS.get(positionals[1])
    const needsId = command !== COMMAND.INCIDENTS_LIST
    const maximumPositionals = needsId ? 3 : 2
    if (positionals.length > maximumPositionals) {
      throw new CliError(`Unexpected argument: ${positionals[maximumPositionals]}`)
    }
    const incidentId = positionals[2] ?? null
    if (needsId && !incidentId) {
      throw new CliError(`incidents ${positionals[1]} requires an incident ID`)
    }
    if (incidentId && !INCIDENT_ID_PATTERN.test(incidentId)) {
      throw new CliError("Incident ID is invalid")
    }
    return { command, configPath: null, incidentId }
  }
  if (positionals[0] === "probe") {
    if (positionals.length > 2) {
      throw new CliError(`Unexpected argument: ${positionals[2]}`)
    }
    return { command: COMMAND.PROBE, configPath: positionals[1] ?? null }
  }
  if (positionals[0] === "cloudflare") {
    if (positionals.length === 1) throw new CliError("cloudflare requires a subcommand")
    throw new CliError(`Unknown command: cloudflare ${positionals[1]}`)
  }
  if (positionals[0] === "help") {
    throw new CliError("help accepts only a command path")
  }
  throw new CliError(`Unknown command: ${positionals[0]}`)
}

function validateOptions(command, configPath, options, provided) {
  if (provided.has("json") && !JSON_COMMANDS.has(command)) {
    throw new CliError(`--json is not valid with ${command.replace(".", " ")}`)
  }
  if (provided.has("profile") && !PROFILE_COMMANDS.has(command)) {
    throw new CliError(`--profile is not valid with ${command.replace(".", " ")}`)
  }
  if (provided.has("concurrency") && command !== COMMAND.PROBE) {
    throw new CliError("--concurrency is valid only with probe")
  }
  if (provided.has("all") && command !== COMMAND.INCIDENTS_LIST) {
    throw new CliError("--all is valid only with incidents list")
  }
  if (provided.has("limit") && command !== COMMAND.INCIDENTS_LIST) {
    throw new CliError("--limit is valid only with incidents list")
  }
  if (provided.has("note") && ![
    COMMAND.INCIDENTS_ACKNOWLEDGE,
    COMMAND.INCIDENTS_DISMISS,
    COMMAND.INCIDENTS_SNOOZE,
  ].includes(command)) {
    throw new CliError("--note is valid only with incident triage mutations")
  }
  if (provided.has("until") && command !== COMMAND.INCIDENTS_SNOOZE) {
    throw new CliError("--until is valid only with incidents snooze")
  }
  if (command === COMMAND.INCIDENTS_SNOOZE && !provided.has("until")) {
    throw new CliError("--until is required with incidents snooze")
  }
  if (configPath && provided.has("profile")) {
    throw new CliError("--profile cannot be combined with an explicit target document")
  }
  if (!Number.isInteger(options.concurrency)
    || options.concurrency < 1
    || options.concurrency > MAXIMUM_CLI_CONCURRENCY) {
    throw new CliError(
      `Concurrency must be an integer from 1 through ${MAXIMUM_CLI_CONCURRENCY}`,
    )
  }
  if (!Number.isInteger(options.limit)
    || options.limit < INCIDENT_LIST_LIMIT.minimum
    || options.limit > INCIDENT_LIST_LIMIT.maximum) {
    throw new CliError(
      `Limit must be an integer from ${INCIDENT_LIST_LIMIT.minimum} through ${INCIDENT_LIST_LIMIT.maximum}`,
    )
  }
}

export function parseCliArguments(argv) {
  if (argv[0] === "cloudflare" && argv[1] === "configure") {
    return Object.freeze({
      command: COMMAND.CLOUDFLARE_CONFIGURE,
      commandArguments: Object.freeze(argv.slice(2)),
      configPath: null,
      help: false,
      options: null,
    })
  }
  const options = {
    all: false,
    concurrency: 5,
    help: false,
    json: false,
    limit: INCIDENT_LIST_LIMIT.default,
    note: null,
    profilePath: DEFAULT_PROFILE_PATH,
    until: null,
  }
  const positionals = []
  const provided = new Set()
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
      if (name === "--all" || name === "--help" || name === "--json") {
        if (attached !== null) throw new CliError(`${name} does not take a value`)
        const option = name.slice(2)
        options[option] = true
        provided.add(option)
      } else if ([
        "--concurrency",
        "--limit",
        "--note",
        "--profile",
        "--until",
      ].includes(name)) {
        const parsed = optionValue(argv, index, attached, name)
        const option = name.slice(2)
        options[option === "profile" ? "profilePath" : option] = option === "concurrency"
          || option === "limit"
            ? Number(parsed.value)
            : parsed.value
        provided.add(option)
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
      if (name === "a" || name === "h" || name === "j") {
        const option = name === "a" ? "all" : name === "h" ? "help" : "json"
        options[option] = true
        provided.add(option)
      } else if (["c", "l", "n", "p", "u"].includes(name)) {
        const parsed = optionValue(argv, index, bundle || null, `-${name}`)
        const option = ({
          c: "concurrency",
          l: "limit",
          n: "note",
          p: "profile",
          u: "until",
        })[name]
        options[option === "profile" ? "profilePath" : option] = option === "concurrency"
          || option === "limit"
            ? Number(parsed.value)
            : parsed.value
        provided.add(option)
        index = parsed.index
        bundle = ""
      } else {
        throw new CliError(`Unknown option: -${name}`)
      }
    }
  }
  if (provided.has("profile")) options.profilePath = path.resolve(options.profilePath)
  if (options.help || positionals[0] === "help") {
    const route = helpRoute(positionals)
    const helpCommand = route.join(".")
    if ([...provided].some((option) => option !== "help")) {
      validateOptions(helpCommand, null, options, provided)
    }
    return Object.freeze({
      command: helpCommand || null,
      configPath: null,
      help: true,
      options: Object.freeze(options),
      route: Object.freeze(route),
    })
  }
  const parsed = commandFromPositionals(positionals)
  validateOptions(parsed.command, parsed.configPath, options, provided)
  return Object.freeze({
    ...parsed,
    help: false,
    options: Object.freeze(options),
  })
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

function targetList(loaded) {
  return loaded.portable.targets.map((target) => ({
    expect: target.expect ?? null,
    expectedStatuses: target.expectedStatuses ?? null,
    id: target.id,
    method: target.method,
    url: target.url,
  }))
}

function expectationLabel(expect) {
  if (!expect) return "-"
  return Object.keys(expect).map((key) => ({
    bodyIncludes: "body",
    contentType: "content-type",
    jsonSubset: "json-subset",
    location: "location",
  })[key]).join(",")
}

function textTargetList(targets) {
  const lines = ["ID\tMETHOD\tEXPECTED\tVALIDATION\tURL"]
  for (const target of targets) {
    lines.push([
      target.id,
      target.method,
      target.expectedStatuses?.join(",") ?? "<500",
      expectationLabel(target.expect),
      target.url,
    ].join("\t"))
  }
  lines.push(`${targets.length} target(s)`)
  return lines.join("\n")
}

function incidentFailure(incident) {
  if (incident.latestStatus !== null) {
    return `HTTP ${incident.latestStatus}${incident.errorCode
      ? ` (${incident.errorCode})`
      : ""}`
  }
  return incident.errorCode || incident.failureKind
}

function incidentSummary(incident) {
  return Object.freeze({
    acknowledgedAt: incident.acknowledgedAt,
    errorCode: incident.errorCode,
    failureKind: incident.failureKind,
    id: incident.id,
    latestSignal: incident.latestSignal,
    latestStatus: incident.latestStatus,
    openedAt: incident.openedAt,
    resolutionReason: incident.resolutionReason,
    resolvedAt: incident.resolvedAt,
    snoozedUntil: incident.snoozedUntil,
    status: incident.status,
    targetId: incident.targetId,
  })
}

function textIncidentList(incidents) {
  const lines = [
    "ID\tTARGET\tSTATUS\tFAILURE\tACKNOWLEDGED\tSNOOZED_UNTIL\tOPENED_AT",
  ]
  for (const incident of incidents) {
    lines.push([
      incident.id,
      incident.targetId,
      incident.status,
      incidentFailure(incident),
      incident.acknowledgedAt || "-",
      incident.snoozedUntil || "-",
      incident.openedAt,
    ].join("\t"))
  }
  lines.push(`${incidents.length} incident(s)`)
  return lines.join("\n")
}

function textIncident(incident) {
  const lines = [
    `ID\t${incident.id}`,
    `TARGET\t${incident.targetId}`,
    `URL\t${incident.targetUrl}`,
    `STATUS\t${incident.status}`,
    `FAILURE\t${incidentFailure(incident)}`,
    `OPENED_AT\t${incident.openedAt}`,
    `RESOLVED_AT\t${incident.resolvedAt || "-"}`,
    `RESOLUTION_REASON\t${incident.resolutionReason || "-"}`,
    `ACKNOWLEDGED_AT\t${incident.acknowledgedAt || "-"}`,
    `SNOOZED_UNTIL\t${incident.snoozedUntil || "-"}`,
    "",
    "CREATED_AT\tACTION\tSNOOZED_UNTIL\tNOTE",
  ]
  for (const action of incident.actions) {
    lines.push([
      action.createdAt,
      action.action,
      action.snoozedUntil || "-",
      action.note || "-",
    ].join("\t"))
  }
  lines.push(`${incident.actions.length} action(s)`)
  return lines.join("\n")
}

async function incidentOperator(parsed, dependencies) {
  const profile = await loadOperatorProfile(parsed.options.profilePath, dependencies)
  const wrangler = await loadOperatorWrangler(profile, dependencies)
  const accountId = dependencies.environment.CLOUDFLARE_ACCOUNT_ID
  const apiToken = dependencies.environment.CLOUDFLARE_API_TOKEN
  if (!ACCOUNT_ID_PATTERN.test(accountId || "")) {
    throw new CliError("CLOUDFLARE_ACCOUNT_ID is unavailable or invalid")
  }
  if (typeof apiToken !== "string" || !apiToken) {
    throw new CliError("CLOUDFLARE_API_TOKEN is unavailable")
  }
  return new CloudflareIncidentOperator({
    accountId,
    apiToken,
    clock: dependencies.clock,
    databaseId: monitorDatabaseId(wrangler),
    fetchImpl: dependencies.fetchImpl,
    randomUUID: dependencies.randomUUID,
  })
}

async function runIncidentCommand(parsed, dependencies) {
  const operator = await incidentOperator(parsed, dependencies)
  if (parsed.command === COMMAND.INCIDENTS_LIST) {
    const incidents = await operator.list({
      all: parsed.options.all,
      limit: parsed.options.limit,
    })
    writeLine(
      dependencies.stdout,
      parsed.options.json
        ? JSON.stringify({ incidents: incidents.map(incidentSummary) })
        : textIncidentList(incidents),
    )
    return EXIT.SUCCESS
  }
  if (parsed.command === COMMAND.INCIDENTS_SHOW) {
    const incident = await operator.show(parsed.incidentId)
    writeLine(
      dependencies.stdout,
      parsed.options.json
        ? JSON.stringify({ incident })
        : textIncident(incident),
    )
    return EXIT.SUCCESS
  }
  let action
  let incident
  if (parsed.command === COMMAND.INCIDENTS_ACKNOWLEDGE) {
    action = INCIDENT_ACTION.ACKNOWLEDGED
    incident = await operator.acknowledge(parsed.incidentId, {
      note: parsed.options.note,
    })
  } else if (parsed.command === COMMAND.INCIDENTS_SNOOZE) {
    action = INCIDENT_ACTION.SNOOZED
    incident = await operator.snooze(parsed.incidentId, {
      note: parsed.options.note,
      until: parsed.options.until,
    })
  } else {
    action = INCIDENT_ACTION.DISMISSED
    incident = await operator.dismiss(parsed.incidentId, {
      note: parsed.options.note,
    })
  }
  writeLine(
    dependencies.stdout,
    parsed.options.json
      ? JSON.stringify({ action, incident })
      : `${action[0].toUpperCase()}${action.slice(1)} incident ${incident.id}`,
  )
  return EXIT.SUCCESS
}

async function targetForCommand(parsed, dependencies) {
  if (parsed.configPath) {
    return loadTargetDocument(parsed.configPath, dependencies)
  }
  return (await loadOperatorTarget(parsed.options.profilePath, dependencies)).loaded
}

async function runProbe(parsed, loaded, dependencies) {
  let targets
  let results
  try {
    targets = await configuredTargets(loaded.candidate)
    results = await probeTargets(
      dependencies.fetchImpl,
      targets,
      new Date(dependencies.clock()).toISOString(),
      parsed.options.concurrency,
    )
  } catch {
    throw new CliError("Probe execution failed", EXIT.RUNTIME)
  }
  const summary = summarizeProbeResults(results)
  const output = results.map(probeResult)
  if (parsed.options.json) {
    writeLine(dependencies.stdout, JSON.stringify({ results: output, summary }))
  } else {
    for (const result of output) {
      const detail = result.httpStatus === null
        ? result.errorCode
        : `HTTP ${result.httpStatus}${result.errorCode ? ` (${result.errorCode})` : ""}`
      writeLine(
        dependencies.stdout,
        `${result.outcome === "success" ? "OK" : "FAIL"} ${result.targetId} ${detail}`,
      )
    }
    writeLine(
      dependencies.stdout,
      `${summary.succeeded} succeeded, ${summary.failed} failed`,
    )
  }
  return summary.failed > 0 ? EXIT.RUNTIME : EXIT.SUCCESS
}

export async function runCli(argv, overrides = {}) {
  const dependencies = {
    clock: Date.now,
    environment: process.env,
    fetchImpl: globalThis.fetch,
    lstatImpl: lstat,
    readFileImpl: readFile,
    randomUUID: () => crypto.randomUUID(),
    stderr: process.stderr,
    stdout: process.stdout,
    ...overrides,
  }
  let parsed
  try {
    parsed = parseCliArguments(argv)
  } catch (error) {
    writeLine(dependencies.stderr, `endpoint-monitor: ${error.message}`)
    return error.exitCode || EXIT.USAGE
  }
  if (parsed.help) {
    dependencies.stdout.write(help(parsed.route))
    return EXIT.SUCCESS
  }
  if (parsed.command === COMMAND.CLOUDFLARE_CONFIGURE) {
    return runConfigure(parsed.commandArguments, dependencies)
  }
  try {
    if (parsed.command === COMMAND.CONFIG_PATH) {
      const profile = await loadOperatorProfile(parsed.options.profilePath, dependencies)
      writeLine(
        dependencies.stdout,
        parsed.options.json
          ? JSON.stringify({ configPath: profile.configPath })
          : profile.configPath,
      )
      return EXIT.SUCCESS
    }
    if (parsed.command === COMMAND.CONFIG_SHOW) {
      const loaded = await targetForCommand(parsed, dependencies)
      writeLine(dependencies.stdout, JSON.stringify(loaded.portable, null, 2))
      return EXIT.SUCCESS
    }
    if (parsed.command === COMMAND.CONFIG_VALIDATE) {
      const loaded = await targetForCommand(parsed, dependencies)
      writeLine(
        dependencies.stdout,
        parsed.options.json
          ? JSON.stringify({ targetCount: loaded.portable.targets.length, valid: true })
          : `Valid target document with ${loaded.portable.targets.length} target(s)`,
      )
      return EXIT.SUCCESS
    }
    if (parsed.command === COMMAND.TARGETS) {
      const { loaded, profile } = await loadOperatorTarget(
        parsed.options.profilePath,
        dependencies,
      )
      const targets = targetList(loaded)
      writeLine(
        dependencies.stdout,
        parsed.options.json
          ? JSON.stringify({ configPath: profile.configPath, targets })
          : textTargetList(targets),
      )
      return EXIT.SUCCESS
    }
    if (parsed.command === COMMAND.PROBE) {
      return await runProbe(
        parsed,
        await targetForCommand(parsed, dependencies),
        dependencies,
      )
    }
    if (INCIDENT_COMMAND_SET.has(parsed.command)) {
      return await runIncidentCommand(parsed, dependencies)
    }
    const { loaded, profile } = await loadOperatorTarget(
      parsed.options.profilePath,
      dependencies,
    )
    const wrangler = await loadOperatorWrangler(profile, dependencies)
    const accountId = dependencies.environment.CLOUDFLARE_ACCOUNT_ID
    if (!ACCOUNT_ID_PATTERN.test(accountId || "")) {
      throw new CliError("CLOUDFLARE_ACCOUNT_ID is unavailable or invalid")
    }
    const rowsWritten = await applyConfiguration(
      dependencies.fetchImpl,
      accountId,
      dependencies.environment.CLOUDFLARE_API_TOKEN,
      monitorDatabaseId(wrangler),
      loaded,
      new Date(dependencies.clock()).toISOString(),
    )
    const result = {
      configFingerprint: loaded.configFingerprint,
      rowsWritten,
      targetCount: loaded.portable.targets.length,
    }
    writeLine(
      dependencies.stdout,
      parsed.options.json
        ? JSON.stringify(result)
        : `Synchronized ${result.targetCount} target(s); D1 rows written: ${result.rowsWritten}`,
    )
    return EXIT.SUCCESS
  } catch (error) {
    writeLine(dependencies.stderr, `endpoint-monitor: ${error.message}`)
    return error.exitCode || (error instanceof TypeError ? EXIT.USAGE : EXIT.RUNTIME)
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2))
}

export { EXIT, help }
