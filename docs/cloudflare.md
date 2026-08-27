# Cloudflare operation

## Resource model

One Worker and one D1 database are required. A Hookrelay service binding is optional. The Worker does not need KV, Queues, Durable Objects, or Analytics Engine.

The generated `wrangler.jsonc` is operator-specific and ignored. It contains resource identifiers and feature flags but no secrets or targets. `endpoint-monitor cloudflare configure` also writes an ignored mode-0600 `.endpoint-monitor.local.json` operator profile that remembers the target-document and Wrangler-configuration paths. `endpoint-monitor config path`, `endpoint-monitor targets`, `endpoint-monitor probe`, and `endpoint-monitor config sync` read that profile so routine operations do not require a target path or D1 identifier. The target document is validated locally and stored as one fingerprinted D1 control row. Reapplying an unchanged document writes nothing, and target-only changes do not require a Worker deployment.

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

Useful safe counts include:

```sql
SELECT COUNT(*) AS exceptional_targets FROM monitor_target_state;
SELECT COUNT(*) AS open_incidents FROM monitor_incident WHERE status = 'open';
SELECT COUNT(*) AS pending_deliveries FROM monitor_outbox WHERE delivered_at IS NULL;
```

Do not use a per-probe history table. Routine health belongs in Workers Observability, while D1 retains only the state needed for thresholds, incidents, deduplication, and retry.

## Analytics behavior

Analytics runs on a five-minute cadence with an overlapping 15-minute window and a two-minute ingestion lag. D1 signal fingerprints deduplicate overlap without a frequently written cursor. Missing several analytics invocations can lose an edge-only observation, but active probes continue independently.

Zone enumeration and GraphQL calls share the invocation subrequest budget. Pagination is validated and bounded. A result at the query limit fails as truncated rather than silently processing an incomplete view.

## Cutover

After shadow verification, create or reconcile the Hookrelay CloudEvents subscription and install its URL and sender HMAC as Worker secrets. Regenerate with delivery enabled, deploy, and verify one controlled signed problem and recovery while downstream sinks are filtered appropriately.

Disable any previous detector only after the new Worker remains healthy and the target list is pruned to intended endpoints. Preserve historical storage until the cutover is accepted. Retire old Hookrelay subscriptions through their supported retirement workflow so recoverable secret state and shared references are handled safely.
