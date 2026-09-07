# Cloudflare operation

## Resource model

One Worker and one D1 database are required. A Hookrelay service binding is optional. The Worker does not need KV, Queues, Durable Objects, or Analytics Engine.

The `@j-256/endpoint-monitor` package owns both sides of deployment: its CLI is the local controller, while its Worker source, D1 migrations, and Wrangler template are immutable assets from the same installed version. The service and controller are never installed or released independently.

Run `endpoint-monitor init` in a project-local npm installation. It creates an operator-owned target document, an ignored mode-0600 `.endpoint-monitor.local.json` profile, and the required `.gitignore` entries. The generated `wrangler.jsonc` is also operator-specific and ignored. It contains resource identifiers, absolute paths to the installed package assets, and feature flags, but no secrets or targets.

Configuration, target, probe, and incident commands read the operator profile so routine operations do not require a target path or D1 identifier.

## Execution ceilings and Free compatibility

The Wrangler template and every generated deployment configuration limit an invocation to 250 ms CPU and 100 total subrequests. Workers Observability for the seven days ending 2026-09-07 recorded a maximum of approximately 22 ms CPU, leaving about 11.4 times the observed peak. The subrequest ceiling preserves more than twice the application's fixed 45-external-subrequest budget plus its bounded D1 work while reducing the Workers Paid default of 10,000.

These custom `limits.cpu_ms` and `limits.subrequests` settings require the Workers Standard usage model. A Free deployment must omit the custom block and receives Cloudflare's fixed per-invocation ceilings of 10 ms CPU, 50 external subrequests, and 1,000 internal-service subrequests. The observed production CPU maximum exceeds the Free allowance, so reducing the target set and keeping optional analytics and delivery disabled is only a candidate fallback, not a verified Free profile. Keep scheduled monitoring disabled on Free until a representative target document remains within the fixed CPU ceiling, or use another runtime adapter and scheduler. Paid is justified for the deployed profile because its observed legitimate execution can exceed 10 ms.

Cloudflare terminates an invocation that exhausts either configured ceiling and records a resource-limit outcome. Correlate that outcome with the bounded run-status record and invocation summary before retrying or raising a limit; a missing completion must become stale rather than healthy. The limits and configuration behavior were verified against [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Wrangler limits configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#limits) on 2026-09-07.

`endpoint-monitor cloudflare bootstrap` creates one D1 database or adopts `--database-id <uuid>`, generates the package-resolved Wrangler configuration, and applies the bundled migrations. A dry run validates the target and reports whether the database would be created, adopted, or reused without writing locally or remotely. Reruns reuse the recorded D1 binding and preserve feature selections that were not explicitly supplied.

The lower-level `endpoint-monitor cloudflare configure` command remains available for an operator who already knows the D1 identifier and needs to regenerate local configuration without creating resources. Bootstrap is the normal first-install and package-upgrade path.

`endpoint-monitor deploy --dry-run` bundles the installed Worker without Cloudflare or durable writes. A live deploy applies pending migrations, preserves any existing D1 configuration without reading the local candidate, publishes the Worker, resolves the account's `workers.dev` subdomain, and verifies public `GET /healthz` with bounded retries. Only an absent configuration is initialized from the validated local candidate at revision zero. If another writer initializes it first, deployment stops for inspection instead of overwriting it.

## Configuration authority and recovery

D1 is the sole executing configuration authority. Local target files are explicit import candidates. `config review` validates a candidate against runtime capacity and compares target IDs, effective target fields, defaults, and fingerprints with the remote revision. Review `config show` and `config remote` for complete values before importing with `config sync --expect-revision <number> --expect-fingerprint <sha256>`. Revision zero means an absent remote row. Both the revision and the exact candidate fingerprint must match; returning to an earlier configuration does not make a stale revision valid again. An unchanged candidate at the reviewed revision writes nothing.

The revision-authority migration preserves the original configuration row, gives it a monotonic revision, and adds database guards against older unconditional updates, upserts, replacement, and deletion. A configuration update and its metadata-only audit entry commit together. The bounded audit stores revisions, fingerprints, target counts, writer identity, and timestamps, not old target documents or credentials. Keep a separate protected export or database backup when recovery needs the previous document.

`config remote` exports the executing document as JSON without opening or replacing the local candidate. It requires the operator profile, generated D1 binding, and Cloudflare read credentials, but no status-endpoint token. Its URLs and response expectations are private. Save only to a new protected file with `umask 077`, inspect it, and deliberately replace a local candidate if appropriate. Missing remote configuration produces an error and no JSON document. A lost write response is not proof of failure: inspect the remote document and revision before reviewing another write.

Apply the additive migration before the updated CLI or management authority is used. Back up the database first. Old scheduled code can continue reading the configuration while ignoring the additive metadata, but an old CLI cannot safely regain unconditional writes by rolling back code alone. Do not remove the revision guards to make an old import work. Use an updated CLI for configuration recovery, preserving newer remote state and its revision. No live probe target or incident needs to be changed to verify this migration.

Configuration imports enforce the adapter's existing per-run probe ceiling and a 256 KiB canonical document limit before writing. These are explicit application bounds, not evidence of measured Free-plan CPU compliance. Accepted imports write the configuration and bounded audit metadata; configuration reads and unchanged imports write nothing. Imports add no separate scheduled work or logging stream. Ordinary healthy probes retain their no-per-target-write invariant, with the aggregate run-status exception documented below. Paid-plan access is not used to bypass those limits.

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
| Protected management | No public feature flag | `MONITOR_DB`, `MANAGEMENT_CREDENTIALS` digest catalog |

Flags accept only `true` and `false`. An enabled feature with a missing required binding fails closed with a fixed configuration code.

The [management contract](management.md) remains independently authorized even through a service binding. It never accepts the status token or account-level deployment token. Apply the additive management migration before enabling credentials. Existing targets, incidents, feature selections, and outbox rows are preserved. Keep a protected database export and the prior Worker artifact before migration and deployment; rolling back code must not remove configuration revision guards or overwrite online edits. Keep credential identity and revision available until accepted receipts have been reconciled.

## Shadow verification

Prepare the Worker with active monitoring enabled and delivery disabled. Optional analytics may be enabled independently.

Verify these conditions before enabling delivery:

- `/healthz` returns a minimal successful response
- Authenticated `/api/status` shows the intended explicit targets and a schedule within capacity
- Every run remains within the probe, concurrency, and subrequest ceilings
- Healthy runs report only their bounded aggregate run-status write, with no per-target healthy state
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
| `endpoint_monitor.management_failed` | Warning | Fixed management failure requiring availability or receipt inspection |

The run summary includes scheduled time, configured and due target counts, probe outcomes, analytics row and match counts, transition count, D1 logical changes, `runStatusWrites`, delivery outcomes, retention count, phase errors, and budgeted subrequests. It intentionally excludes full URLs and raw exception text.

Use the Worker name as the primary Observability filter, then filter the structured `event` field. A normal steady-state scheduled minute has `runStatusWrites: 1` and `d1Writes: 1`; duplicate completion for the same minute adds no snapshot write. Investigate other repeated changes without configuration, incident, delivery, or retention activity. The incident engine still writes no per-target state for ordinary healthy probes.

## Positive execution and check evidence

Apply the additive run-status migration before deploying a Worker that publishes snapshots. It does not edit targets, incidents, or credentials. Keep the database backup and previous artifact. Rolling back the Worker preserves the additive table, but completion evidence becomes stale when older code stops publishing it; do not mistake rollback liveness for monitoring evidence.

Use `endpoint-monitor status` or `endpoint-monitor status --json` for scheduler completion and configuration-bound target checks without probing targets or opening the local target file. The [management freshness contract](management.md#freshness-and-recovery) specifies deadlines, disabled runs, revision matching, retained passes, and late/duplicate completion behavior. `/healthz` proves only that the HTTP handler responded. It does not prove the cron trigger fired.

Run-status storage has fixed capacity and one aggregate upsert per completed minute, regardless of whether zero or the bounded maximum targets were due. An uninterrupted minute schedule therefore adds at most 1,440 successful snapshot changes per day, excluding all other runtime and management work. This is an application-write projection, not a billable D1 row-write estimate: index accounting, read scans, CPU, and logs require measurement. Scheduled runs add no extra network requests or per-check log events for snapshots. Reads inspect at most the fixed ring and return bounded target pages. Workers Free CPU and aggregate D1/log allowance compliance for representative target sets remains unmeasured; Paid access does not make this feature Free-plan verified. Document measured overages before increasing these bounds.

## D1 inspection

The protected management API supplies bounded operational reads; the optional status API remains available to existing operators. For direct database inspection, query only the narrow tables needed and avoid selecting `config_json`, `target_url`, `event_json`, management inputs, previews, or notes into shared logs.

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

Do not use an unbounded per-probe history table. Routine detailed history belongs in Workers Observability. D1 retains sparse incident-engine state, immutable operator actions, deduplication, retry, and the fixed-capacity aggregate run-status ring.

## Analytics behavior

Analytics runs on a five-minute cadence with an overlapping 15-minute window and a two-minute ingestion lag. D1 signal fingerprints deduplicate overlap without a frequently written cursor. Missing several analytics invocations can lose an edge-only observation, but active probes continue independently.

Zone enumeration and GraphQL calls share the invocation subrequest budget. Pagination is validated and bounded. A result at the query limit fails as truncated rather than silently processing an incomplete view.

## Cutover

After shadow verification, create or reconcile the Hookrelay CloudEvents subscription and install its URL and sender HMAC as Worker secrets. Regenerate with delivery enabled, deploy, and verify one controlled signed problem and recovery while downstream sinks are filtered appropriately.

Disable any previous detector only after the new Worker remains healthy and the target list is pruned to intended endpoints. Preserve historical storage until the cutover is accepted. Retire old Hookrelay subscriptions through their supported retirement workflow so recoverable secret state and shared references are handled safely.
