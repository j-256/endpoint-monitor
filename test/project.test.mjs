import assert from "node:assert/strict"
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  GITIGNORE_ENTRIES,
  initUsage,
  initializeOperatorProject,
  operatorProjectPaths,
  parseInitArguments,
  runInit,
} from "../src/project.mjs"

function streamFixture() {
  let output = ""
  return {
    read: () => output,
    write: (value) => {
      output += value
    },
  }
}

test("project initializer documents and parses portable option forms", async () => {
  assert.match(initUsage(), /^Usage: endpoint-monitor init/)
  assert.match(initUsage(), /without network access or provider writes/)
  const parsed = parseInitArguments(["-ndoperator"])
  assert.equal(parsed.directory, path.resolve("operator"))
  assert.equal(parsed.dryRun, true)
  const long = parseInitArguments(["--directory=service", "--dry-run"])
  assert.equal(long.directory, path.resolve("service"))
  assert.equal(long.dryRun, true)

  for (const argv of [
    ["--directory="],
    ["--unknown"],
    ["-x"],
    ["operator"],
    ["--", "operator"],
  ]) {
    const stderr = streamFixture()
    const stdout = streamFixture()
    assert.equal(await runInit(argv, { stderr, stdout }), 2)
    assert.match(stderr.read(), /^endpoint-monitor:/)
    assert.equal(stdout.read(), "")
  }
})

test("project initializer creates private files and preserves operator edits", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "endpoint-monitor-project-"))
  context.after(() => rm(root, { force: true, recursive: true }))
  const directory = path.join(root, "operator")
  const paths = operatorProjectPaths(directory)
  const initialized = await initializeOperatorProject(directory)
  assert.deepEqual([...initialized.created].sort(), [
    ".endpoint-monitor.local.json",
    ".gitignore",
    "endpoint-monitor.json",
  ])
  assert.equal((await lstat(paths.profilePath)).mode & 0o777, 0o600)
  assert.equal((await lstat(paths.targetPath)).mode & 0o777, 0o600)
  const profile = JSON.parse(await readFile(paths.profilePath, "utf8"))
  assert.deepEqual(profile, {
    configPath: paths.targetPath,
    schemaVersion: 1,
    wranglerPath: paths.wranglerPath,
  })
  const target = JSON.parse(await readFile(paths.targetPath, "utf8"))
  assert.equal(target.targets.every((entry) => entry.url.includes("example.")), true)
  const ignore = await readFile(paths.gitignorePath, "utf8")
  for (const entry of GITIGNORE_ENTRIES) assert.match(ignore, new RegExp(`^${entry.replace(".", "\\.")}$`, "m"))

  const editedTarget = `${JSON.stringify({ schemaVersion: 1, targets: [] }, null, 2)}\n`
  await writeFile(paths.targetPath, editedTarget, "utf8")
  await writeFile(paths.gitignorePath, "node_modules", "utf8")
  await writeFile(paths.profilePath, `${JSON.stringify({
    wranglerPath: paths.wranglerPath,
    configPath: paths.targetPath,
    schemaVersion: 1,
  }, null, 2)}\n`, "utf8")
  await chmod(paths.profilePath, 0o600)
  const rerun = await initializeOperatorProject(directory)
  assert.deepEqual([...rerun.preserved].sort(), [
    ".endpoint-monitor.local.json",
    "endpoint-monitor.json",
  ])
  assert.deepEqual(rerun.updated, [".gitignore"])
  assert.equal(await readFile(paths.targetPath, "utf8"), editedTarget)
  assert.match(await readFile(paths.gitignorePath, "utf8"), /^node_modules\n/)
})

test("project initializer dry run reports a plan without creating a directory", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "endpoint-monitor-dry-init-"))
  context.after(() => rm(root, { force: true, recursive: true }))
  const directory = path.join(root, "operator")
  const stderr = streamFixture()
  const stdout = streamFixture()
  assert.equal(await runInit(["--directory", directory, "--dry-run"], {
    stderr,
    stdout,
  }), 0)
  assert.match(stdout.read(), /^Would initialize Endpoint Monitor project/)
  await assert.rejects(lstat(directory), (error) => error.code === "ENOENT")
})

test("project initializer rejects symlinks, loose profiles, and changed paths", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "endpoint-monitor-unsafe-init-"))
  context.after(() => rm(root, { force: true, recursive: true }))
  const first = path.join(root, "first")
  await initializeOperatorProject(first)
  const firstPaths = operatorProjectPaths(first)
  await rm(firstPaths.targetPath)
  await symlink("elsewhere.json", firstPaths.targetPath)
  await assert.rejects(
    initializeOperatorProject(first),
    /Path must be a regular file/,
  )

  const second = path.join(root, "second")
  await initializeOperatorProject(second)
  const secondPaths = operatorProjectPaths(second)
  await chmod(secondPaths.profilePath, 0o644)
  await assert.rejects(
    initializeOperatorProject(second),
    /Path must have mode 0600/,
  )
  await chmod(secondPaths.profilePath, 0o600)
  await writeFile(secondPaths.profilePath, `${JSON.stringify({
    configPath: firstPaths.targetPath,
    schemaVersion: 1,
    wranglerPath: secondPaths.wranglerPath,
  })}\n`, "utf8")
  await assert.rejects(
    initializeOperatorProject(second),
    /names different project paths/,
  )
})
