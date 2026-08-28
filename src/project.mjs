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

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PACKAGE_TARGET_EXAMPLE_PATH = path.join(
  PACKAGE_ROOT,
  "endpoint-monitor.example.json",
)
const PACKAGE_WRANGLER_EXAMPLE_PATH = path.join(
  PACKAGE_ROOT,
  "wrangler.example.jsonc",
)
const PACKAGE_WORKER_PATH = path.join(
  PACKAGE_ROOT,
  "src",
  "adapters",
  "cloudflare",
  "worker.mjs",
)
const PACKAGE_MIGRATIONS_PATH = path.join(PACKAGE_ROOT, "migrations")
const PROJECT_FILES = Object.freeze({
  GITIGNORE: ".gitignore",
  PROFILE: ".endpoint-monitor.local.json",
  TARGETS: "endpoint-monitor.json",
  WRANGLER: "wrangler.jsonc",
})
const GITIGNORE_ENTRIES = Object.freeze([
  `/${PROJECT_FILES.PROFILE}`,
  `/${PROJECT_FILES.TARGETS}`,
  `/${PROJECT_FILES.WRANGLER}`,
  "/.wrangler/",
])
const EXIT = Object.freeze({ RUNTIME: 1, SUCCESS: 0, USAGE: 2 })

class ProjectError extends Error {
  constructor(message, exitCode = EXIT.USAGE) {
    super(message)
    this.exitCode = exitCode
  }
}

function projectDependencies(overrides = {}) {
  return {
    chmodImpl: chmod,
    lstatImpl: lstat,
    mkdirImpl: mkdir,
    readFileImpl: readFile,
    renameImpl: rename,
    unlinkImpl: unlink,
    writeFileImpl: writeFile,
    ...overrides,
  }
}

async function optionalMetadata(filename, dependencies) {
  try {
    return await dependencies.lstatImpl(filename)
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw new ProjectError(`Cannot inspect path: ${filename}`, EXIT.RUNTIME)
  }
}

function assertRegularFile(metadata, filename, { privateFile = false } = {}) {
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new ProjectError(`Path must be a regular file: ${filename}`)
  }
  if (privateFile && (metadata.mode & 0o077) !== 0) {
    throw new ProjectError(`Path must have mode 0600: ${filename}`)
  }
}

async function removeTemporary(filename, dependencies) {
  try {
    await dependencies.unlinkImpl(filename)
  } catch {}
}

export async function writePrivateFile(filename, contents, overrides = {}) {
  const dependencies = projectDependencies(overrides)
  const existing = await optionalMetadata(filename, dependencies)
  if (existing) assertRegularFile(existing, filename)
  await dependencies.mkdirImpl(path.dirname(filename), { mode: 0o700, recursive: true })
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.tmp-${process.pid}-${crypto.randomUUID()}`,
  )
  try {
    await dependencies.writeFileImpl(temporary, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    await dependencies.renameImpl(temporary, filename)
    await dependencies.chmodImpl(filename, 0o600)
  } catch (error) {
    await removeTemporary(temporary, dependencies)
    throw error
  }
}

async function writePublicFile(filename, contents, mode, dependencies) {
  const existing = await optionalMetadata(filename, dependencies)
  if (existing) assertRegularFile(existing, filename)
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.tmp-${process.pid}-${crypto.randomUUID()}`,
  )
  try {
    await dependencies.writeFileImpl(temporary, contents, {
      encoding: "utf8",
      flag: "wx",
      mode,
    })
    await dependencies.renameImpl(temporary, filename)
    await dependencies.chmodImpl(filename, mode)
  } catch (error) {
    await removeTemporary(temporary, dependencies)
    throw error
  }
}

async function createPrivateFile(filename, contents, dependencies) {
  await dependencies.writeFileImpl(filename, contents, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  })
  await dependencies.chmodImpl(filename, 0o600)
}

export function operatorProjectPaths(directory = process.cwd()) {
  const resolved = path.resolve(directory)
  return Object.freeze({
    directory: resolved,
    gitignorePath: path.join(resolved, PROJECT_FILES.GITIGNORE),
    profilePath: path.join(resolved, PROJECT_FILES.PROFILE),
    targetPath: path.join(resolved, PROJECT_FILES.TARGETS),
    wranglerPath: path.join(resolved, PROJECT_FILES.WRANGLER),
  })
}

function expectedProfile(paths) {
  return Object.freeze({
    configPath: paths.targetPath,
    schemaVersion: 1,
    wranglerPath: paths.wranglerPath,
  })
}

function validateExistingProfile(source, paths) {
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new ProjectError(`Operator profile is not valid JSON: ${paths.profilePath}`)
  }
  const expected = expectedProfile(paths)
  if (parsed === null
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || parsed.schemaVersion !== expected.schemaVersion
    || parsed.configPath !== expected.configPath
    || parsed.wranglerPath !== expected.wranglerPath
    || Object.keys(parsed).some((key) => !(key in expected))) {
    throw new ProjectError(
      `Operator profile names different project paths: ${paths.profilePath}`,
    )
  }
}

async function inspectInitialization(paths, dependencies) {
  const [directory, gitignore, profile, target] = await Promise.all([
    optionalMetadata(paths.directory, dependencies),
    optionalMetadata(paths.gitignorePath, dependencies),
    optionalMetadata(paths.profilePath, dependencies),
    optionalMetadata(paths.targetPath, dependencies),
  ])
  if (directory && (directory.isSymbolicLink() || !directory.isDirectory())) {
    throw new ProjectError(`Project path must be a directory: ${paths.directory}`)
  }
  if (gitignore) assertRegularFile(gitignore, paths.gitignorePath)
  if (profile) {
    assertRegularFile(profile, paths.profilePath, { privateFile: true })
    validateExistingProfile(
      await dependencies.readFileImpl(paths.profilePath, "utf8"),
      paths,
    )
  }
  if (target) assertRegularFile(target, paths.targetPath, { privateFile: true })
  return Object.freeze({ directory, gitignore, profile, target })
}

function gitignoreContents(source) {
  const normalized = source && !source.endsWith("\n") ? `${source}\n` : source
  const lines = new Set(normalized.split(/\r?\n/))
  const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.has(entry))
  return Object.freeze({
    contents: missing.length > 0
      ? `${normalized}${missing.join("\n")}\n`
      : normalized,
    missing,
  })
}

export async function initializeOperatorProject(
  directory,
  { dryRun = false } = {},
  overrides = {},
) {
  const dependencies = projectDependencies(overrides)
  const paths = operatorProjectPaths(directory)
  const existing = await inspectInitialization(paths, dependencies)
  const currentIgnore = existing.gitignore
    ? await dependencies.readFileImpl(paths.gitignorePath, "utf8")
    : ""
  const ignore = gitignoreContents(currentIgnore)
  const created = []
  const preserved = []
  const updated = []
  if (existing.target) preserved.push(PROJECT_FILES.TARGETS)
  else created.push(PROJECT_FILES.TARGETS)
  if (existing.profile) preserved.push(PROJECT_FILES.PROFILE)
  else created.push(PROJECT_FILES.PROFILE)
  if (!existing.gitignore) created.push(PROJECT_FILES.GITIGNORE)
  else if (ignore.missing.length > 0) updated.push(PROJECT_FILES.GITIGNORE)
  else preserved.push(PROJECT_FILES.GITIGNORE)
  if (!dryRun) {
    try {
      if (!existing.directory) {
        await dependencies.mkdirImpl(paths.directory, { recursive: true })
      }
      if (!existing.target) {
        const example = await dependencies.readFileImpl(
          PACKAGE_TARGET_EXAMPLE_PATH,
          "utf8",
        )
        await createPrivateFile(paths.targetPath, example, dependencies)
      }
      if (!existing.profile) {
        await createPrivateFile(
          paths.profilePath,
          `${JSON.stringify(expectedProfile(paths), null, 2)}\n`,
          dependencies,
        )
      }
      if (!existing.gitignore || ignore.missing.length > 0) {
        const mode = existing.gitignore ? existing.gitignore.mode & 0o777 : 0o644
        await writePublicFile(paths.gitignorePath, ignore.contents, mode, dependencies)
      }
    } catch (error) {
      if (error instanceof ProjectError) throw error
      throw new ProjectError("Cannot initialize operator project", EXIT.RUNTIME)
    }
  }
  return Object.freeze({
    created: Object.freeze(created),
    directory: paths.directory,
    dryRun,
    paths,
    preserved: Object.freeze(preserved),
    updated: Object.freeze(updated),
  })
}

export function initUsage() {
  return `Usage: endpoint-monitor init [options]

Initialize one operator project without network access or provider writes. The
command creates an ignored mode-0600 target document and operator profile in
the selected directory while preserving existing operator files.

Options:
  -d, --directory <path>  Operator project directory (default: current directory)
  -n, --dry-run           Validate and report the local file plan without writes
  -h, --help              Show this help

Exit status:
  0  Project initialized or dry-run passed
  1  File operation failed
  2  Usage or local project precondition is invalid
`
}

function optionValue(argv, index, attached, name) {
  if (attached !== null) {
    if (!attached) throw new ProjectError(`${name} requires a value`)
    return { index, value: attached }
  }
  const value = argv[index + 1]
  if (value === undefined || value === "") {
    throw new ProjectError(`${name} requires a value`)
  }
  return { index: index + 1, value }
}

export function parseInitArguments(argv) {
  const options = {
    directory: process.cwd(),
    dryRun: false,
    help: false,
  }
  let endOfOptions = false
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
      if (name === "--dry-run" || name === "--help") {
        if (attached !== null) throw new ProjectError(`${name} does not take a value`)
        options[name === "--help" ? "help" : "dryRun"] = true
      } else if (name === "--directory") {
        const parsed = optionValue(argv, index, attached, name)
        options.directory = parsed.value
        index = parsed.index
      } else {
        throw new ProjectError(`Unknown option: ${name}`)
      }
      continue
    }
    let bundle = argument.slice(1)
    while (bundle) {
      const name = bundle[0]
      bundle = bundle.slice(1)
      if (name === "h" || name === "n") {
        options[name === "h" ? "help" : "dryRun"] = true
      } else if (name === "d") {
        const parsed = optionValue(argv, index, bundle || null, "-d")
        options.directory = parsed.value
        index = parsed.index
        bundle = ""
      } else {
        throw new ProjectError(`Unknown option: -${name}`)
      }
    }
  }
  if (positionals.length > 0) {
    throw new ProjectError(`Unexpected argument: ${positionals[0]}`)
  }
  return Object.freeze({
    ...options,
    directory: path.resolve(options.directory),
  })
}

function writeLine(stream, value) {
  stream.write(`${value}\n`)
}

export async function runInit(argv, overrides = {}) {
  const stderr = overrides.stderr ?? process.stderr
  const stdout = overrides.stdout ?? process.stdout
  let options
  try {
    options = parseInitArguments(argv)
  } catch (error) {
    writeLine(stderr, `endpoint-monitor: ${error.message}`)
    return error.exitCode || EXIT.USAGE
  }
  if (options.help) {
    stdout.write(initUsage())
    return EXIT.SUCCESS
  }
  try {
    const result = await initializeOperatorProject(
      options.directory,
      { dryRun: options.dryRun },
      overrides,
    )
    writeLine(
      stdout,
      `${result.dryRun ? "Would initialize" : "Initialized"} Endpoint Monitor project at ${result.directory}`,
    )
    if (result.created.length > 0) {
      writeLine(stdout, `${result.dryRun ? "Create" : "Created"}: ${result.created.join(", ")}`)
    }
    if (result.updated.length > 0) {
      writeLine(stdout, `${result.dryRun ? "Update" : "Updated"}: ${result.updated.join(", ")}`)
    }
    if (result.preserved.length > 0) {
      writeLine(stdout, `Preserved: ${result.preserved.join(", ")}`)
    }
    return EXIT.SUCCESS
  } catch (error) {
    writeLine(stderr, `endpoint-monitor: ${error.message}`)
    return error.exitCode || EXIT.RUNTIME
  }
}

export {
  EXIT,
  GITIGNORE_ENTRIES,
  PACKAGE_MIGRATIONS_PATH,
  PACKAGE_ROOT,
  PACKAGE_TARGET_EXAMPLE_PATH,
  PACKAGE_WORKER_PATH,
  PACKAGE_WRANGLER_EXAMPLE_PATH,
  PROJECT_FILES,
  ProjectError,
}
