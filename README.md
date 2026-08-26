# Endpoint Monitor

Endpoint Monitor detects failures on an explicit set of public HTTP and HTTPS URLs and emits incident transitions for downstream alerting. It does not discover targets, assume hostname routing, or remediate failures.

The monitoring core is runtime-neutral JavaScript. The included Cloudflare Workers adapter adds deterministic Cron scheduling, exceptional-state-only D1 persistence, Workers Observability logs, optional Cloudflare edge analytics, and signed CloudEvents delivery through Hookrelay.

## Why explicit targets

Traffic, DNS inventory, and provider metadata do not define what should be monitored. They can include retired hosts, external fetch destinations, alternate routes, and hostnames whose useful path is not `/`. Endpoint Monitor therefore treats the configuration file as the only enrollment authority. Provider data may corroborate a configured target but cannot add one.

## Quick start

Install the pinned development dependencies with Node.js 22 or newer:

```sh
npm ci
```

Validate the example without network access:

```sh
node src/cli.mjs validate endpoint-monitor.example.json
```

Show the fully resolved configuration:

```sh
node src/cli.mjs normalize endpoint-monitor.example.json
```

Probe every target once without persistence or delivery:

```sh
node src/cli.mjs probe endpoint-monitor.example.json
```

Add `--json` to `validate` or `probe` for machine-readable output. A failed target makes `probe` exit with status 1.

## Configuration

```json
{
  "schemaVersion": 1,
  "defaults": {
    "failureThreshold": 2,
    "method": "GET",
    "probeIntervalMinutes": 5,
    "recoveryThreshold": 2,
    "timeoutMilliseconds": 10000
  },
  "targets": [
    {
      "id": "example-home",
      "url": "https://example.com/"
    },
    {
      "expectedStatuses": [200, 204],
      "id": "example-health",
      "url": "https://status.example.net/health"
    }
  ]
}
```

`id` is the stable incident and scheduling identity. It must be a lower-case DNS-style label. `url` must use a public DNS hostname, may include an exact path and query, and may not include credentials or a fragment. Do not place credentials in query parameters because complete URLs are retained in protected status and incident records.

`method` is `GET` or `HEAD`. Redirects are not followed, so the configured host and route are what the probe verifies. `failureThreshold`, `recoveryThreshold`, and `timeoutMilliseconds` may be overridden per target.

By default, any response below HTTP 500 proves reachability. HTTP 520 through 526 and 530 open an incident immediately; other server responses and network failures use `failureThreshold`. Supply `expectedStatuses` only when the endpoint has a narrower application contract. Only successful active probes can resolve an incident.

## Cloudflare deployment

The Cloudflare adapter uses one Cron trigger per minute. A stable hash distributes targets across `probeIntervalMinutes`, with at most 10 probes and five concurrent outbound connections per invocation. Configuration that cannot satisfy that cadence is rejected rather than silently probed less often. The adapter also enforces a 45-external-subrequest budget and uses manual redirects. Review the [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) before deploying on a different plan or after changing these bounds.

Create a D1 database and retain the returned UUID:

```sh
npx wrangler d1 create endpoint-monitor
```

Preview generation using an operator-owned target file:

```sh
npm run configure:cloudflare -- --config /path/to/private/endpoint-monitor.json --database-id <database-uuid> --dry-run
```

Generate the ignored mode-0600 `wrangler.jsonc`, apply migrations, and store the validated target document in D1:

```sh
npm run configure:cloudflare -- --config /path/to/private/endpoint-monitor.json --database-id <database-uuid>
npm run db:migrate:remote
npm run configure:cloudflare -- --config /path/to/private/endpoint-monitor.json --database-id <database-uuid> --apply-config
```

The configurator also writes an ignored mode-0600 `.endpoint-monitor.local.json` profile beside `wrangler.jsonc`. The profile remembers the absolute target-document and Wrangler paths but contains no target values, resource identifiers, or secrets. The configurator does not create resources or install secrets. It uses `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` only when applying D1 configuration, sends the document as a parameterized query, and avoids a write when its fingerprint is unchanged.

Routine target changes do not require remembering the D1 identifier or deployment flags:

```sh
npm run targets
npm run targets -- path
npm run targets -- probe
npm run targets -- sync
```

`targets` lists the explicit IDs, methods, status contracts, and URLs. `targets -- path` identifies the one JSON file to edit. After editing, probe it locally and run `targets -- sync`; the sync validates the complete document, reads the existing generated D1 binding, and writes only when the configuration fingerprint changed. No Worker deployment is required for target-only changes.

Install only the secrets required by selected features through concealed Wrangler input:

```sh
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put ENDPOINT_MONITOR_HOOKRELAY_URL
npx wrangler secret put ENDPOINT_MONITOR_HOOKRELAY_HMAC
npx wrangler secret put ENDPOINT_MONITOR_STATUS_TOKEN
```

Regenerate with the desired feature flags. A safe first deployment enables probes but leaves delivery off:

```sh
npm run configure:cloudflare -- --config /path/to/private/endpoint-monitor.json --database-id <database-uuid> --enabled --status
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

Custom logs contain fixed event names, target IDs, statuses, bounded error codes, counts, and incident IDs. They exclude URLs, query strings, exception messages, Hookrelay paths, signatures, HMACs, API response bodies, and secret values.

## Portability

The core configuration, scheduler, probes, reducer, event model, and Hookrelay signing code do not depend on Cloudflare. A different runtime adapter supplies scheduling, exceptional-state persistence, delivery, and an HTTP implementation. See [Architecture](docs/architecture.md) for the adapter contract.

## Development

```sh
npm test
npm run test:coverage
npm run check:publication
npm run deploy:dry-run
```

`npm run check` runs the complete local release gate. The project is licensed under [AGPL-3.0-only](LICENSE).
