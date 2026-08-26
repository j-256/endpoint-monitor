#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { isMainModule } from "../src/main-module.mjs"

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const REQUIRED_FILES = Object.freeze([
  ".github/dependabot.yml",
  ".github/workflows/ci.yml",
  ".gitignore",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "endpoint-monitor.example.json",
  "package-lock.json",
  "package.json",
  "wrangler.example.jsonc",
  "scripts/targets.mjs",
])
const FORBIDDEN_BASENAMES = new Set([
  ".dev.vars",
  ".endpoint-monitor.local.json",
  ".env",
  "endpoint-monitor.json",
  "wrangler.jsonc",
])
const PRIVATE_PATH_PATTERN = new RegExp(
  "(?:/(?:x|c|z)/|/Users/[^/]+/\\.(?:x|z|c)/|/home/[^/]+/\\.(?:x|z|c)/)",
)
const FORBIDDEN_UNICODE = new Set([0x2014, 0x2018, 0x2019, 0x201c, 0x201d])

function usage() {
  return `Usage: check-publication [--help]

Check the repository candidate set for required public-project files, private deployment artifacts, machine-local paths, raw Hookrelay routes, private-key material, and unsafe examples.
`
}

function candidateFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: PROJECT_ROOT, encoding: "utf8" },
  )
  return output.split("\0").filter(Boolean).sort()
}

function isReservedExampleHostname(hostname) {
  return ["example.com", "example.net", "example.org"].some((domain) => (
    hostname === domain || hostname.endsWith(`.${domain}`)
  ))
}

function isPrivateArtifact(filename) {
  const basename = path.basename(filename)
  return FORBIDDEN_BASENAMES.has(basename)
    || basename.startsWith(".dev.vars.")
    || basename.startsWith(".env.")
}

function contentIssues(filename, content) {
  const issues = []
  if (PRIVATE_PATH_PATTERN.test(content)) {
    issues.push(`${filename}: contains a machine-local private path`)
  }
  for (const character of content) {
    if (FORBIDDEN_UNICODE.has(character.codePointAt(0))) {
      issues.push(`${filename}: contains prohibited smart punctuation`)
      break
    }
  }
  if (/-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/.test(content)) {
    issues.push(`${filename}: contains private-key material`)
  }
  if (/(?:github_pat_|gh[opsu]_|glpat-)[A-Za-z0-9_-]{20,}/.test(content)) {
    issues.push(`${filename}: contains a token-shaped value`)
  }
  const hookPattern = /https:\/\/[^\s"'<>]+\/hook\/cloudevents\/[A-Za-z0-9_-]{22,}/g
  for (const value of content.match(hookPattern) || []) {
    if (!isReservedExampleHostname(new URL(value).hostname)) {
      issues.push(`${filename}: contains a raw non-example Hookrelay route`)
    }
  }
  return issues
}

async function structuredIssues(files) {
  const issues = []
  const example = JSON.parse(
    await readFile(path.join(PROJECT_ROOT, "endpoint-monitor.example.json"), "utf8"),
  )
  for (const target of example.targets || []) {
    if (!isReservedExampleHostname(new URL(target.url).hostname)) {
      issues.push("endpoint-monitor.example.json: target is not a reserved example domain")
    }
  }
  const wrangler = JSON.parse(
    await readFile(path.join(PROJECT_ROOT, "wrangler.example.jsonc"), "utf8"),
  )
  if (wrangler.d1_databases?.some((binding) => (
    binding.database_id !== "00000000-0000-0000-0000-000000000000"
  ))) {
    issues.push("wrangler.example.jsonc: contains a non-placeholder D1 identifier")
  }
  if (Object.entries(wrangler.vars || {}).some(([name, value]) => (
    name.includes("SECRET")
      || name.includes("HMAC")
      || name.includes("TOKEN")
      || (name.endsWith("_ENABLED") && value !== "false")
  ))) {
    issues.push("wrangler.example.jsonc: contains a secret binding or enabled live feature")
  }
  const packageJson = JSON.parse(
    await readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"),
  )
  if (packageJson.license !== "AGPL-3.0-only") {
    issues.push("package.json: license must be AGPL-3.0-only")
  }
  if (packageJson.repository?.url !== "git+https://github.com/j-256/endpoint-monitor.git") {
    issues.push("package.json: repository identity is missing or unexpected")
  }
  const ignore = await readFile(path.join(PROJECT_ROOT, ".gitignore"), "utf8")
  for (const required of [".dev.vars", "endpoint-monitor.json", "wrangler.jsonc"]) {
    if (!ignore.split(/\r?\n/).includes(required)) {
      issues.push(`.gitignore: missing private artifact ${required}`)
    }
  }
  for (const executable of [
    "scripts/configure-cloudflare.mjs",
    "scripts/targets.mjs",
    "src/cli.mjs",
  ]) {
    if (!files.includes(executable)) continue
    const metadata = await lstat(path.join(PROJECT_ROOT, executable))
    if ((metadata.mode & 0o111) === 0) {
      issues.push(`${executable}: user-invoked script is not executable`)
    }
  }
  return issues
}

export async function checkPublication() {
  const files = candidateFiles()
  const issues = []
  for (const required of REQUIRED_FILES) {
    if (!files.includes(required)) issues.push(`Missing required file: ${required}`)
  }
  for (const filename of files) {
    if (isPrivateArtifact(filename)) {
      issues.push(`${filename}: private deployment artifact is publishable`)
      continue
    }
    const fullPath = path.join(PROJECT_ROOT, filename)
    const metadata = await lstat(fullPath)
    if (metadata.isSymbolicLink()) {
      issues.push(`${filename}: symbolic links are not publishable`)
      continue
    }
    if (!metadata.isFile()) continue
    const content = await readFile(fullPath, "utf8")
    issues.push(...contentIssues(filename, content))
  }
  if (REQUIRED_FILES.every((required) => files.includes(required))) {
    issues.push(...await structuredIssues(files))
  }
  return Object.freeze(issues)
}

async function main(argv) {
  if (argv.length === 1 && ["-h", "--help"].includes(argv[0])) {
    process.stdout.write(usage())
    return 0
  }
  if (argv.length > 0) {
    process.stderr.write(`check-publication: Unexpected argument: ${argv[0]}\n`)
    return 2
  }
  let issues
  try {
    issues = await checkPublication()
  } catch {
    process.stderr.write("check-publication: Check execution failed\n")
    return 1
  }
  if (issues.length > 0) {
    for (const issue of issues) process.stderr.write(`check-publication: ${issue}\n`)
    return 1
  }
  process.stdout.write("Publication checks passed\n")
  return 0
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}

export { contentIssues, isPrivateArtifact, main, usage }
