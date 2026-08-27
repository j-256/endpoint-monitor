# Changelog

All notable changes to Endpoint Monitor are documented here. The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Schema version 2 response validation for normalized redirect locations, media types, bounded text markers, and JSON subsets
- Operator-only incident listing, inspection, acknowledgement, snooze, and dismissal through authenticated Cloudflare D1 access

### Changed

- Probe bodies are read only for configured validation, bounded to a 64 KiB prefix or complete JSON body, discarded immediately, and represented by fixed failure codes
- Resolved delivery transitions wait for their corresponding problem transition, and protected status includes incident acknowledgement and snooze summaries

## [0.1.0] - 2026-08-27

### Added

- Runtime-neutral target validation, deterministic scheduling, bounded active probes, and thresholded incident transitions
- Cloudflare Workers adapter with sparse D1 persistence, optional verified edge analytics, protected status output, and bounded observability
- Signed CloudEvents delivery through Hookrelay with retry state and shadow-to-live bridging
- Unified operator CLI for configuration inspection, validation, probing, synchronization, and Cloudflare preparation
- Public project safeguards, release archives with checksums, GitHub Actions verification, and reproducible portfolio cover automation

[Unreleased]: https://github.com/j-256/endpoint-monitor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/j-256/endpoint-monitor/releases/tag/v0.1.0
