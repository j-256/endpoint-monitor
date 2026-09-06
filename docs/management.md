# Protected management contract

The Cloudflare adapter exposes `POST /admin/api/v1` for trusted operator applications. Authentication is required before reading the request body or accessing D1. This is a provider API, not a browser session endpoint: an application server authorizes its human operator and explicit workspace membership before asserting their workspace and actor IDs. Service binding requests require the same credential as HTTP requests. No command accepts a caller-selected provider URL, SQL, bearer route, account token, or arbitrary method.

## Credentials and scope

Install `MANAGEMENT_CREDENTIALS` as a Worker secret using a protected stdin or interactive secret-input workflow. It is a JSON array of credential records with these fields:

| Field | Meaning |
| --- | --- |
| `id` | Stable credential identity using letters, digits, colon, underscore, dot, or hyphen |
| `revision` | Positive safe integer, advanced when replacing its authority |
| `tokenHash` | Lower-case hexadecimal SHA-256 digest of the complete bearer token |
| `expiresAt` | UTC ISO timestamp including milliseconds |
| `workspaceIds` | Explicit nonempty workspace allowlist |
| `capabilities` | Nonempty subset of `read`, `configure`, and `triage` |

Generate a cryptographically random 32-byte base64url value and prefix it with `epm_`. Store the complete token only in the calling server's secret store, never in browser state, source, screenshots, logs, or command arguments. The provider stores its digest, not the token. Credential IDs and digests must be unique; malformed catalogs fail closed. All operations require `read`, with `configure` or `triage` additionally required for the corresponding plan and application. Status-endpoint and Cloudflare account tokens do not grant management access.

A provider instance owns one target configuration. Allowlisting a workspace intentionally grants it access to that instance's resources; it does not partition targets into separate tenants. Applications own narrower repository or project associations and enforce their own memberships. Use separate provider instances when target configuration itself must be isolated. Operation records are additionally scoped to workspace, actor, credential identity, and credential revision, so one workspace cannot inspect another workspace's receipts even when both can view shared provider resources.

Credential rotation can leave multiple distinct identities in the catalog while operations are reconciled. Do not remove or expire the old identity before recovering its uncertain accepted operations. A replacement revision cannot impersonate the old revision to read receipts. The operator's authenticated D1 recovery path remains available if the old credential is lost; preserve private records and inspect before acting again.

## Request and response

Send `Content-Type: application/json` and `Authorization: Bearer <management-token>`. The versioned envelope is strict, including command-specific input keys:

```json
{
  "version": 1,
  "command": "incidents",
  "input": {
    "workspaceId": "example-workspace",
    "status": "open"
  }
}
```

Successful responses contain `version`, the credential's `capabilities`, and `result`. Errors contain only a fixed `error.code` and `error.message`; callers must not depend on exception text. Responses use `Cache-Control: no-store`. Workspace denial and inaccessible operation identity return `not_found`. Missing or expired credentials return `unauthorized`; insufficient capability returns `forbidden`. Invalid input, stale reviews, storage capacity, and provider unavailability remain distinct. An unavailable response to application is not proof that nothing happened: reconcile the same plan before reviewing another operation.

## Commands

Every command requires `workspaceId`. Optional paging cursors are opaque to callers and bound to the kind and filters of the read. Target pagination also binds the configuration revision; restart pagination after a conflict.

| Command | Additional input | Result |
| --- | --- | --- |
| `snapshot` | None | Configuration metadata, feature readiness, bounded incident and pending-delivery counts |
| `configuration` | None | Private executing portable document and revision, or an absent configuration |
| `targets` | Optional `cursor` | Target page with response expectations and exceptional-state evidence |
| `target` | `targetId` | One target in the same target-page result shape |
| `incidents` | Optional `status` (`open`, `resolved`, or `all`), `targetId`, `cursor` | Incident page including revisions |
| `incident` | `incidentId`, optional `cursor` | Incident and a page of immutable triage history |
| `configuration_plan` | `actorId`, `expectedRevision`, `configuration` | Review bound to the exact candidate and remote revision |
| `triage_plan` | `actorId`, `expectedRevision`, `incidentId`, `action`, optional `note`, `until` | Review bound to incident state and configuration revision |
| `operation_apply` | `actorId`, `planId` | Stable accepted receipt or a conflict without domain effects |
| `operation_get` | `actorId`, `planId` | Reviewed, expired, or applied operation and retained result |

Configuration plans accept the portable schema documented in the README and enforce the same schedule capacity and canonical size limit as CLI imports. A stale form revision is rejected, not silently rebased over remote edits. Plan creation persists review metadata but does not edit targets. Application commits the configuration, its revision audit, and the accepted operation together. An unchanged candidate still produces an operation receipt but does not rewrite configuration or its audit.

Triage actions are `acknowledged`, `snoozed`, and `dismissed`. Only snooze accepts `until`, which must be a future RFC 3339 timestamp; it is normalized to UTC in the review. Notes are bounded plain text and must not contain secrets. Acknowledgement records attention, not recovery. Snooze delays pending problem delivery but does not pause probes or retract sent messages. Dismissal records an operator resolution; persistent failures can open another incident. The management handler never calls Hookrelay directly. The existing outbox and scheduled delivery own notification attempts and ordering.

The CLI uses the same triage statement builder, and CLI actions invalidate pending management reviews through incident revisions. Incident detail in the CLI shows a bounded latest history and explicitly marks omitted older actions; management history supports paging them.

## Freshness and recovery

Read time is not probe time. Healthy probes without exceptional state intentionally perform no durable writes. The snapshot therefore reports execution health as unobserved, and target evidence distinguishes unobserved, exceptional, incident, and configuration-changed states. Use Workers Observability for invocation health and normal probe summaries. A successful configuration save affects future invocations, not an already-running probe or evidence of endpoint recovery.

Reviews expire after ten minutes. Application rechecks actor, workspace, credential revision and capabilities, expiry, configuration revision, and incident revision where relevant. Acceptance and domain effects use one atomic batch; the acceptance guard also checks database time so a delayed request cannot commit after expiry using an earlier application timestamp. Concurrent duplicate application returns the same receipt and never reapplies the domain operation. Domain failure rolls back acceptance; a lost response can be reconciled with `operation_get`. Accepted receipts retain the original result even if configuration or incident state later changes. They are not a live status view.

Accepted receipts remain available for thirty days. Reviewed raw input is discarded upon acceptance; protected preview metadata, triage notes, and result remain until retention expires. Expired unaccepted reviews and expired receipts are removed when another review is created, not by healthy probes. If a client loses its plan ID, inspect its own operation journal or use protected operator recovery rather than issuing a blind replacement operation.

## Bounded work and plan portability

Management pages contain at most fifty records and explicit continuation cursors. Snapshot counts are bounded samples with a `truncated` flag, not silently incomplete totals. Request bodies are limited to 288 KiB with a five-second total read deadline, including stalled streaming bodies. The executing canonical configuration remains limited to 256 KiB. Credential catalogs are bounded to twenty entries and 16 KiB. Storage permits at most one hundred pending reviews and one thousand retained operation records per provider instance; capacity failures preserve unexpired receipts instead of deleting recovery evidence.

Management reads do not contact targets, query inventory, enqueue notifications, or write probe history. Plans and accepted actions do incur bounded D1 work. These safeguards are application limits, not a measured promise that all management invocations fit the Workers Free CPU allowance. Paid access does not establish Free-plan compliance. Before increasing document size, page size, retention, or operation capacity, measure representative CPU, D1 work, and logging usage and document any Free-plan overage. The management API adds only a fixed failure log event and does not log routine payloads, credentials, target URLs, or notes.
