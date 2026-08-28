# Releases

Endpoint Monitor distributes one scoped npm package containing the controller CLI, runtime-neutral core, Cloudflare Worker, D1 migrations, and deployment templates. GitHub Releases provide the package as `j-256-endpoint-monitor-X.Y.Z.tgz` with `SHA256SUMS`. The npm registry is a planned second distribution channel for the same package, not a separate controller or service release.

Creating a software release never deploys an operator's Worker or mutates Cloudflare resources. Operators install or upgrade the package in their own local project and explicitly run its bootstrap and deploy commands.

## Version policy

Versions follow Semantic Versioning. Before 1.0, a minor version may include a breaking configuration, CLI, event, or adapter contract change. A patch version preserves those public contracts. Every release has a dated entry in [CHANGELOG.md](../CHANGELOG.md).

The Git tag is exactly `v` followed by the `package.json` version. `package-lock.json` carries the same package name and version. Release validation rejects a mismatch among those values or the changelog heading.

## Local release gate

Install the lockfile with Node.js 22 or newer, then run:

```sh
npm ci
npm run check
```

The gate runs tests and coverage thresholds, scans the publication candidate set, validates the committed project cover, packs and smoke-installs the release archive in a temporary operator project, exercises CLI help and initialization, checks a bootstrap plan, bundles the installed Worker with its production Wrangler dependency, and rejects unexpected package files.

To exercise the tagged build without publishing anything, replace `X.Y.Z` with the candidate version:

```sh
npm run release:build -- --tag vX.Y.Z
```

This recreates ignored `dist/`, writes the installable tarball, and writes its SHA-256 checksum. The command does not create a commit, tag, release, deployment, or registry publication.

## Preparing a version

1. Update `package.json` and `package-lock.json` together with `npm version X.Y.Z --no-git-tag-version`.
2. Move the completed entries under `Unreleased` into a dated `## [X.Y.Z] - YYYY-MM-DD` changelog section and update comparison links.
3. Run `npm run check` and inspect `npm pack --dry-run --json` if the distribution boundary changed.
4. Commit the version preparation with a Conventional Commit.
5. Create an annotated `vX.Y.Z` tag on the reviewed `main` commit.
6. Push `main` and the explicit tag atomically so neither ref is accepted unless both are accepted:

```sh
git push --atomic origin main vX.Y.Z
```

The tag-triggered [release workflow](../.github/workflows/release.yml) checks out the exact tagged source, installs the lockfile, validates the tag and package, rebuilds the archive, and creates a GitHub Release with generated notes, the tarball, and `SHA256SUMS`. Its token receives only `contents: write`.

## Verifying an archive

Download both release assets into one directory. On macOS:

```sh
shasum -a 256 -c SHA256SUMS
```

On systems with GNU coreutils:

```sh
sha256sum -c SHA256SUMS
```

Install and exercise the verified archive in a project-local operator directory without fetching a package by this name from a registry:

```sh
mkdir endpoint-monitor-service
cd endpoint-monitor-service
npm init -y
npm install --save-exact /path/to/j-256-endpoint-monitor-X.Y.Z.tgz
npm exec -- endpoint-monitor init
npm exec -- endpoint-monitor cloudflare bootstrap --dry-run
```

The archive smoke test performs the same lifecycle with synthetic targets and a placeholder D1 binding. It proves packaging and bundling only; it does not create provider resources or publish a Worker.

## npm publication

Registry publication will expose `@j-256/endpoint-monitor` from the same release commit and package allowlist. An operator will replace the archive install with `npm install --save-exact @j-256/endpoint-monitor`; every subsequent command remains unchanged. Publication must retain the package-local executable and exact production Wrangler dependency so the installed controller continues to resolve its matching Worker and migrations.

Before enabling registry publication, configure npm publication authentication and provenance in the release workflow, remove the package's `private` guard in the version-preparation commit, and extend the release gate to inspect the registry-facing artifact. Do not create separate controller and Worker packages.

## Failed release runs

Do not move or replace a release tag to repair a failure. Fix the cause on `main`, prepare a new version, and create a new tag. A rerun is appropriate only when the tagged source and generated assets remain correct and the failure was transient.

If the workflow created no GitHub Release, the failed tag can remain as an auditable marker while the replacement version is prepared. If it created a draft, review and remove that draft through GitHub before retrying; published assets should be treated as immutable.
