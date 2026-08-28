# Cloudflare operation

## Resource model

One Worker and one D1 database are required. A Hookrelay service binding is optional. The Worker does not need KV, Queues, Durable Objects, or Analytics Engine.

The `@j-256/endpoint-monitor` package owns both sides of deployment: its CLI is the local controller, while its Worker source, D1 migrations, and Wrangler template are immutable assets from the same installed version. The service and controller are never installed or released independently.

Run `endpoint-monitor init` in a project-local npm installation. It creates an operator-owned target document, an ignored mode-0600 `.endpoint-monitor.local.json` profile, and the required `.gitignore` entries. The generated `wrangler.jsonc` is also operator-specific and ignored. It contains resource identifiers, absolute paths to the installed package assets, and feature flags, but no secrets or targets.

Configuration, target, probe, and incident commands read the operator profile so routine operations do not require a target path or D1 identifier.

`endpoint-monitor cloudflare bootstrap` creates one D1 database or adopts `--database-id <uuid>`, generates the package-resolved Wrangler configuration, and applies the bundled migrations. A dry run validates the target and reports whether the database would be created, adopted, or reused without writing locally or remotely. Reruns reuse the recorded D1 binding and preserve feature selections that were not explicitly supplied.

The lower-level `endpoint-monitor cloudflare configure` command remains available for an operator who already knows the D1 identifier and needs to regenerate local configuration without creating resources. Bootstrap is the normal first-install and package-upgrade path.

`endpoint-monitor deploy --dry-run` bundles the installed Worker without Cloudflare or durable writes. A live deploy applies pending migrations, stores the validated target document as one fingerprinted D1 control row, publishes the Worker, resolves the account's `workers.dev` subdomain, and verifies public `GET /healthz` with bounded retries. Reapplying an unchanged target document writes nothing, and later target-only changes can use `endpoint-monitor config sync` without a Worker deployment.

## Public probe routing

The Worker configuration enables Cloudflare's [`global_fetch_strictly_public`](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public) compatibility flag. Global `fetch()` therefore enters the public Cloudflare routing path instead of using same-zone behavior that can bypass mapped Workers and other public controls. This makes each probe reflect what an external client reaches, which is the monitoring contract.

Public routing can re-enter a Worker. Do not configure this Endpoint Monitor Worker's own `workers.dev` URL or another route that loops back to it as a target. Deployment health verification runs in the local controller, not inside the Worker, so its `/healthz` request does not create that recursion.

## Feature bindings

| Feature | Generated variable | Required secret or binding |
| --- | --- | --- |
| Active monitoring | `ENDPOINT_MONITOR_ENABLED` | `MONITOR_DB` |
| Cloudflare analytics | `CLOUDFLARE_ANALYTICS_ENABLED`, `CLOUDFLARE_ACCOUNT_ID` | `CLOUDFLARE_API_TOKEN` |
| Hookrelay delivery | `ENDPOINT_MONITOR_DELIVERY_ENABLED` | `ENDPOINT_MONITOR_HOOKRELAY_URL`, `ENDPOINT_MONITOR_HOOKRELAY_HMAC`, optional `HOOKRELAY` service binding |
| Protected status | `ENDPOINT_MONITOR_STATUS_ENABLED` | `ENDPOINT_MONITOR_STATUS_TOKEN` |

Flags accept only `true` and `false`. An enabled feature with a missing required binding fails closed with a fixed configuration code.

## Shadow verification

Prepare the Worker with active monitoring enabled and delivery disabled. Optional analytics may be enabled independently.

Verify these conditions before enabling delivery:

- `/healthz` returns a minimal successful response
- Authenticated `/api/status` shows the intended explicit targets and a schedule within capacity
- Every run remains within the probe, concurrency, and subrequest ceilings
- Healthy runs report zero D1 writes
- A controlled synthetic HTTP 526 opens an incident immediately
- The synthetic target recovers only after its configured number of successful probes
- Logs contain target IDs and fixed codes but no target URLs, query strings, Hookrelay paths, exception text, or secrets
- Analytics rows from external zones, unconfigured hostnames, and unmatched paths do not create incidents

Shadow incidents are durable but create no delivery rows. Enabling delivery later bridges only incidents that are still open.

## Workers Observability

The example enables Workers Logs and invocation logs. Platform invocation records provide outcome, CPU time, wall time, and trigger data. Endpoint Monitor adds these structured event names:

| Event | Level | Purpose |
| --- | --- | --- |
| `endpoint_monitor.run` | Info | One bounded per-invocation summary |
| `endpoint_monitor.transition` | Info | Incident opened or recovered |
| `endpoint_monitor.phase_error` | Error | Optional analytics phase failed |
| `endpoint_monitor.delivery_failed` | Error | One outbox attempt failed |
| `endpoint_monitor.runtime_error` | Error | Critical scheduled invocation failure |

The run summary includes scheduled time, configured and due target counts, probe outcomes, analytics row and match counts, transition count, D1 row writes, delivery outcomes, retention count, phase errors, and budgeted subrequests. It intentionally excludes full URLs and raw exception text.

Use the Worker name as the primary Observability filter, then filter the structured `event` field. A normal steady-state run has `d1Writes: 0`. Repeated nonzero values without incident activity indicate a configuration or state-machine regression worth investigating.

## D1 inspection

The protected status API is the preferred operational view. For direct database inspection, query only the narrow tables needed and avoid selecting `config_json`, `target_url`, or `event_json` into shared logs.

The operator CLI provides the authenticated incident view without enabling protected HTTP status:

```sh
npm exec -- endpoint-monitor incidents list
npm exec -- endpoint-monitor incidents list -a -l 50
npm exec -- endpoint-monitor incidents show <incident-id>
```

Mutations require D1 write permission. Acknowledge records review, snooze delays only a pending problem transition, and dismiss resolves while leaving a persistent failure eligible to reopen:

```sh
npm exec -- endpoint-monitor incidents acknowledge <incident-id> -n "Under investigation"
npm exec -- endpoint-monitor incidents snooze <incident-id> -u 2026-08-28T03:00:00Z
npm exec -- endpoint-monitor incidents dismiss <incident-id> -n "False positive"
```

Every long CLI option has a short equivalent. Use `endpoint-monitor help incidents <command>` for complete forms, environment requirements, and exit statuses. Do not store credentials or private response content in triage notes.

Useful safe counts include:

```sql
SELECT COUNT(*) AS exceptional_targets FROM monitor_target_state;
SELECT COUNT(*) AS open_incidents FROM monitor_incident WHERE status = 'open';
SELECT COUNT(*) AS pending_deliveries FROM monitor_outbox WHERE delivered_at IS NULL;
```

Do not use a per-probe history table. Routine health belongs in Workers Observability, while D1 retains only the state needed for thresholds, incidents, immutable operator actions, deduplication, and retry.

## Analytics behavior

Analytics runs on a five-minute cadence with an overlapping 15-minute window and a two-minute ingestion lag. D1 signal fingerprints deduplicate overlap without a frequently written cursor. Missing several analytics invocations can lose an edge-only observation, but active probes continue independently.

Zone enumeration and GraphQL calls share the invocation subrequest budget. Pagination is validated and bounded. A result at the query limit fails as truncated rather than silently processing an incomplete view.

## Cutover

After shadow verification, create or reconcile the Hookrelay CloudEvents subscription and install its URL and sender HMAC as Worker secrets. Regenerate with delivery enabled, deploy, and verify one controlled signed problem and recovery while downstream sinks are filtered appropriately.

Disable any previous detector only after the new Worker remains healthy and the target list is pruned to intended endpoints. Preserve historical storage until the cutover is accepted. Retire old Hookrelay subscriptions through their supported retirement workflow so recoverable secret state and shared references are handled safely.
