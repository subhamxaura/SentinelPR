# Retention policy and operations

SentinelPR retention is an application-level, opt-in maintenance job. It is **disabled by default**; setting `RETENTION_ENABLED=1` is the only way to schedule deletion. It runs from the review worker, waits about one minute after startup for its first pass, then runs at the configured interval. A Redis `SET NX` lease prevents concurrent passes across worker replicas. Each pass is bounded by `RETENTION_BATCH_SIZE` for each data class, so older rows can take several intervals to clear.

## Recommended rollout

1. Review the ages in [configuration.md](configuration.md#database-and-artifact-retention) and confirm they match customer contracts, legal holds, and internal records policy.
2. Verify PostgreSQL backup/restore and object-store recovery on isolated systems. Retention is not a backup or restore mechanism.
3. Set `RETENTION_ENABLED=1` and `RETENTION_DRY_RUN=1`. Restart the review worker and inspect its structured `Retention pass finished` log. A dry run reports current eligible counts and does not delete records, objects, or outbox rows.
4. Investigate unexpected candidate counts before proceeding. When approved, set `RETENTION_DRY_RUN=0`; keep retention enabled and monitor the worker logs and `ArtifactDeletion` backlog behavior.
5. To stop future passes, set `RETENTION_ENABLED=0` and restart the review worker. A deletion intent already committed to the artifact outbox continues to be retried because it represents a previously approved deletion.

Never turn on retention against a database or bucket before a recoverable backup is available. Do not use broad object-store lifecycle expiry rules: the application protects baseline artifacts and existing references, while an independent bucket expiry may not.

## What is eligible

| Data | Eligibility | Default age |
| --- | --- | --- |
| Sessions | `expiresAt` is at or before the pass time | expired |
| Review runs (and findings) | terminal status `success`, `failure`, or `error` | 180 days |
| Visual runs (and snapshots) | terminal status `passed`, `failed`, or `error` | 90 days |
| Synthetic runs (and step results) | terminal status `passed`, `failed`, or `error` | 90 days |
| Queue job records | `completed` or `failed`, with old `finishedAt` | 30 days |
| Webhook deliveries | `processed`, `skipped`, or `failed` | 90 days |
| Dispatched review outbox rows | status `dispatched` and old `dispatchedAt` | 30 days |
| Artifacts | old and unreferenced by any baseline, snapshot, or synthetic step | 90 days |
| Audit logs | never by default; only when `RETENTION_AUDIT_LOG_DAYS` is explicitly positive | indefinite |

Queued/running review, visual and synthetic work is never selected. Baseline artifacts, including historical baseline versions, remain protected while referenced. Deleting a terminal run cascades its findings/snapshots/steps; artifacts that become orphaned are eligible on that same pass if they fit in the bounded page, or a later pass otherwise.

## Artifact deletion and recovery

PostgreSQL and object storage do not share a transaction. To avoid losing deletion intent, the maintenance service deletes each eligible `Artifact` metadata row and inserts an `ArtifactDeletion` row with the storage key in the same database transaction, after rechecking all references. A concurrent baseline/reference that wins the database race leaves the artifact row and object intact.

The worker then deletes the object and removes the outbox row on success. If storage deletion fails, the outbox retains only the safe error class plus an attempt count and next retry time; retries use capped exponential backoff. A committed deletion intent is not cancelled when scheduled retention is later disabled. Alert on sustained worker errors and investigate persistent outbox backlog before manual intervention; do not delete the outbox row while the object may still exist.

## Configuration and observability

See the complete validated `RETENTION_*` variable table in [configuration.md](configuration.md#database-and-artifact-retention). The worker logs a completion report with per-class counts; failures log exception class names only, never object keys or raw infrastructure error messages. The PostgreSQL indexes required for bounded age/status scans and the deletion-outbox table are applied by normal Prisma migrations.
