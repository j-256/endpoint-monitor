# Changelog

All notable changes to Endpoint Monitor are documented here. The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Fixed-capacity scheduled-run snapshots with configuration-bound check outcomes, retained passes, and separate scheduler and target freshness
- Read-only `status` CLI and shared protected management/status evidence without probing targets or reading a local candidate

### Changed

- Healthy scheduled runs persist only their bounded aggregate completion snapshot while the incident engine retains no ordinary healthy per-target state

## [0.2.1] - 2026-08-29

### Fixed

- Release parser tests isolate ambient GitHub tag metadata so tag-triggered artifact builds verify deterministic parser behavior

## [0.2.0] - 2026-08-29

### Added

- Explicit target-document selection for the `targets` command, matching validation and probing workflows

## [0.1.0] - 2026-08-28

### Added

- Runtime-neutral target validation, deterministic scheduling, bounded active probes, and thresholded incident transitions
- Schema version 2 response validation for normalized redirect locations, media types, bounded text markers, and JSON subsets
- Operator-only incident listing, inspection, acknowledgement, snooze, and dismissal through authenticated Cloudflare D1 access
- Cloudflare Workers adapter with sparse D1 persistence, optional verified edge analytics, protected status output, and bounded observability
- Signed CloudEvents delivery through Hookrelay with retry state and shadow-to-live bridging
- One installable `@j-256/endpoint-monitor` package containing the controller CLI, Worker, migrations, and deployment templates
- Project initialization, D1 bootstrap, package-resolved deployment, and public post-deploy health verification
- Public project safeguards, GitHub Release archives with checksums, CI verification, installed-package deployment smoke tests, and reproducible portfolio cover automation

### Changed

- Probe bodies are read only for configured validation, bounded to a 64 KiB prefix or complete JSON body, discarded immediately, and represented by fixed failure codes
- Resolved delivery transitions wait for their corresponding problem transition, and protected status includes incident acknowledgement and snooze summaries

[Unreleased]: https://github.com/j-256/endpoint-monitor/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/j-256/endpoint-monitor/releases/tag/v0.2.1
[0.2.0]: https://github.com/j-256/endpoint-monitor/releases/tag/v0.2.0
[0.1.0]: https://github.com/j-256/endpoint-monitor/releases/tag/v0.1.0
