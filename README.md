# Endpoint Monitor

Endpoint Monitor detects failures on an explicit set of public HTTP and HTTPS URLs and emits incident transitions for downstream alerting. It does not discover targets, assume hostname routing, or remediate failures.

The monitoring core is runtime-neutral JavaScript. The included Cloudflare Workers adapter adds deterministic Cron scheduling, exceptional-state-only D1 persistence, Workers Observability logs, optional Cloudflare edge analytics, and signed CloudEvents delivery through Hookrelay.

![Synthetic Endpoint Monitor operator run and incident lifecycle](docs/screenshots/cover.png)

## Why explicit targets

Traffic, DNS inventory, and provider metadata do not define what should be monitored. They can include retired hosts, external fetch destinations, alternate routes, and hostnames whose useful path is not `/`. Endpoint Monitor therefore treats the configuration file as the only enrollment authority. Provider data may corroborate a configured target but cannot add one.

## Installation

GitHub Releases contain an installable `endpoint-monitor-X.Y.Z.tgz` archive and `SHA256SUMS`. Download both assets, verify the checksum, and install the archive directly so npm does not resolve an unrelated registry package with the same unscoped name:

```sh
shasum -a 256 -c SHA256SUMS
npm install --global ./endpoint-monitor-X.Y.Z.tgz
endpoint-monitor --help
```

Use a source checkout for Worker deployment or development because it includes the locked Wrangler development dependency and release tooling. See [Releases](docs/releases.md) for artifact contents, GNU checksum verification, versioning, and the maintainer procedure.

## Quick start

From a source checkout, install the pinned development dependencies with Node.js 22 or newer:

```sh
npm ci
```

The package exposes one `endpoint-monitor` executable. The examples below use that installed name; from a source checkout without it on `PATH`, substitute `node src/cli.mjs`.

Validate the example without network access:

```sh
endpoint-monitor config validate endpoint-monitor.example.json
```

Show the fully resolved target document:

```sh
endpoint-monitor config show endpoint-monitor.example.json
```

Probe every target once without persistence or delivery:

```sh
endpoint-monitor probe endpoint-monitor.example.json
```

Add `--json` to `config validate` or `probe` for machine-readable output. A failed target makes `probe` exit with status 1. Both `endpoint-monitor help <command>` and `endpoint-monitor <command> --help` show the same command help.

## Configuration

```json
{
  "schemaVersion": 2,
  "defaults": {
    "failureThreshold": 2,
    "method": "GET",
    "probeIntervalMinutes": 5,
    "recoveryThreshold": 2,
    "timeoutMilliseconds": 10000
  },
  "targets": [
    {
      "expect": {
        "bodyIncludes": "Example Domain",
        "contentType": "text/html"
      },
      "expectedStatuses": [200],
      "id": "example-home",
      "url": "https://example.com/"
    },
    {
      "expect": {
        "contentType": "application/json",
        "jsonSubset": {
          "ok": true
        }
      },
      "expectedStatuses": [200],
      "id": "example-health",
      "url": "https://status.example.net/health"
    },
    {
      "expect": {
        "location": {
          "url": "https://example.org/docs?probe=1"
        }
      },
      "expectedStatuses": [301],
      "id": "example-redirect",
      "url": "https://old.example.org/docs?probe=1"
    }
  ]
}
```

`id` is the stable incident and scheduling identity. It must be a lower-case DNS-style label. `url` must use a public DNS hostname, may include an exact path and query, and may not include credentials or a fragment. Do not place credentials in query parameters because complete URLs are retained in protected status and incident records.

`method` is `GET` or `HEAD`. Redirects are not followed, so the configured host and route are what the probe verifies. `failureThreshold`, `recoveryThreshold`, and `timeoutMilliseconds` may be overridden per target.

By default, any response below HTTP 500 proves reachability. HTTP 520 through 526 and 530 open an incident immediately; other server responses and network failures use `failureThreshold`. Supply `expectedStatuses` only when the endpoint has a narrower application contract. Only successful active probes can resolve an incident.

Schema version 1 remains accepted for status-only documents. Schema version 2 adds the optional `expect` object:

- `contentType` matches the media type case-insensitively and ignores parameters such as `charset`
- `bodyIncludes` requires one non-empty text marker of at most 1,024 bytes
- `jsonSubset` recursively requires the configured object properties while allowing extra response properties; configured arrays match exactly
- `location` resolves the response header against the target URL and compares normalized URL components; set `ignoreQuery` to `true` only when query differences are intentionally irrelevant

Location validation requires explicit 3xx `expectedStatuses`. Body validation requires `GET`. Status is checked before other expectations. Text markers are searched within at most the first 64 KiB and stop the read as soon as they match; JSON validation requires a complete body within that limit. Read content is discarded immediately and never included in diagnostics. A failed expectation records the observed HTTP status plus a fixed error code and follows the configured failure threshold.

## Cloudflare deployment

The Cloudflare adapter uses one Cron trigger per minute. A stable hash distributes targets across `probeIntervalMinutes`, with at most 10 probes and five concurrent outbound connections per invocation. Configuration that cannot satisfy that cadence is rejected rather than silently probed less often. The adapter also enforces a 45-external-subrequest budget and uses manual redirects. Review the [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) before deploying on a different plan or after changing these bounds.

Create a D1 database and retain the returned UUID:

```sh
npx wrangler d1 create endpoint-monitor
```

Preview generation using an operator-owned target document:

```sh
endpoint-monitor cloudflare configure --config /path/to/private/endpoint-monitor.json --database-id <database-uuid> --dry-run
```

Generate the ignored mode-0600 `wrangler.jsonc`, apply migrations, and store the validated target document in D1:

```sh
endpoint-monitor cloudflare configure --config /path/to/private/endpoint-monitor.json --database-id <database-uuid>
npm run db:migrate:remote
endpoint-monitor cloudflare configure --config /path/to/private/endpoint-monitor.json --database-id <database-uuid> --apply-config
```

The configurator also writes an ignored mode-0600 `.endpoint-monitor.local.json` operator profile beside `wrangler.jsonc`. The operator profile remembers the absolute target-document and Wrangler-configuration paths but contains no target values, resource identifiers, or secrets. The configurator does not create resources or install secrets. It uses `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` only when applying D1 configuration, sends the document as a parameterized query, and avoids a write when its fingerprint is unchanged.

Routine target changes do not require remembering the D1 identifier or deployment flags:

```sh
endpoint-monitor config path
endpoint-monitor config validate
endpoint-monitor targets
endpoint-monitor probe
endpoint-monitor config sync
```

`config path` identifies the active target document. `targets` lists its explicit IDs, methods, status and response contracts, and URLs. Profile-backed `config validate` and `probe` use that document automatically; both accept an explicit target-document argument for ad hoc use. After editing, probe it locally and run `config sync`; synchronization validates the complete document, reads the existing generated D1 binding, and writes only when the configuration fingerprint changed. No Worker deployment is required for target-only changes. Use `--profile <path>` with profile-backed commands to select a non-default operator profile.

Install only the secrets required by selected features through concealed Wrangler input:

```sh
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put ENDPOINT_MONITOR_HOOKRELAY_URL
npx wrangler secret put ENDPOINT_MONITOR_HOOKRELAY_HMAC
npx wrangler secret put ENDPOINT_MONITOR_STATUS_TOKEN
```

Regenerate with the desired feature flags. A safe first deployment enables probes but leaves delivery off:

```sh
endpoint-monitor cloudflare configure --config /path/to/private/endpoint-monitor.json --database-id <database-uuid> --enabled --status
npm run deploy
```

Add `--analytics` for optional Cloudflare analytics. Add `--delivery` only after the Hookrelay subscription is live. If Hookrelay is another Worker in the same account, add `--hookrelay-service <worker-name>` to use a service binding; otherwise delivery uses the public HTTPS route.

The target document is stored in D1 rather than an environment variable because Workers cap individual variables at 5 KB. See [Cloudflare operation](docs/cloudflare.md) for shadow verification, Observability fields, and cutover guidance.

## Storage behavior

Every enabled invocation reads one configuration row and the small exceptional-state set. A healthy target with no candidate or incident causes no D1 write. Repeated failures for an already-open incident also cause no write. D1 changes are limited to configuration changes, failure or recovery candidates, incident transitions, unique provider signals, delivery attempts, suppression after configuration changes, and periodic retention cleanup.

At one Cron invocation per minute, the Worker receives 1,440 scheduled invocations per day regardless of target count. The actual probe total is controlled by the target interval. Workers Observability carries invocation health, CPU time, wall time, subrequest count, and compact run summaries without turning routine success into D1 history.

## Hookrelay events

Delivery uses structured CloudEvents 1.0 with source `urn:endpoint-monitor` and these types:

- `urn:endpoint-monitor:problem:v1`
- `urn:endpoint-monitor:recovered:v1`

The exact serialized body is signed as `X-Hookrelay-Signature-256: sha256=<hex>` using HMAC-SHA256. An outbox retries failed delivery with bounded exponential backoff. Incidents opened while delivery is disabled are bridged into the outbox when delivery is enabled, so shadow mode does not lose an ongoing problem.

## HTTP and diagnostics

`GET /healthz` returns only service liveness. `/api/status` is hidden unless status is enabled and requires `Authorization: Bearer <ENDPOINT_MONITOR_STATUS_TOKEN>`. Its protected response includes target URLs, schedule capacity, exceptional states, incidents, and delivery backlog.

Custom logs contain fixed event names, target IDs, statuses, bounded error codes, counts, and incident IDs. They exclude URLs, query strings, response headers, exception messages, Hookrelay paths, signatures, HMACs, API response bodies, and secret values.

## Portability

The core configuration, scheduler, probes, reducer, event model, and Hookrelay signing code do not depend on Cloudflare. A different runtime adapter supplies scheduling, exceptional-state persistence, delivery, and an HTTP implementation. See [Architecture](docs/architecture.md) for the adapter contract.

## Development

```sh
npm run check
```

`npm run check` runs the complete local release gate, including package smoke installation and validation of the committed portfolio cover. Install Playwright Chromium with `npx playwright install chromium`, then run `npm run capture:cover` to regenerate `docs/screenshots/cover.png` from its tracked synthetic HTML scene.

See the [changelog](CHANGELOG.md), [release procedure](docs/releases.md), and [contribution guidance](CONTRIBUTING.md). The project is licensed under [AGPL-3.0-only](LICENSE).
