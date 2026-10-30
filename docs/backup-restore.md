# Backups, point-in-time recovery and replay safety

Imagine the database as a notebook. A base backup photographs the whole notebook. PostgreSQL's write-ahead log (WAL) records later edits. Restoring the photograph and replaying the edits up to a selected point gives point-in-time recovery (PITR). A plain SQL dump is useful for other purposes but does not provide this physical WAL recovery chain. See [PostgreSQL 16 continuous archiving](https://www.postgresql.org/docs/16/continuous-archiving.html).

M3-04 implements and tests this locally. It does not promise a production recovery time or data-loss limit. The database, base backup and WAL archive are on the same computer: losing that computer can lose all three.

## Create and verify a staging backup

```powershell
npm run staging:backup
```

The script validates the Compose project identity, requires archiving, runs `pg_basebackup` with streamed WAL into a new uniquely named directory, verifies the backup manifest with `pg_verifybackup`, switches WAL, and waits for the segment to appear in the archive. It never overwrites a previous backup. [PostgreSQL documents the physical backup requirements](https://www.postgresql.org/docs/16/app-pgbasebackup.html).

| Location                                     | Contents                                       |
| -------------------------------------------- | ---------------------------------------------- |
| Docker volume `memorae-staging_staging_data` | Current PostgreSQL cluster                     |
| Docker volume `memorae-staging_base_backups` | Separate base backup directories and manifests |
| Docker volume `memorae-staging_wal_archive`  | Completed WAL segments required for recovery   |
| `.staging-local/base-*.json`                 | Private backup verification reports            |

The archive script copies through a temporary file, syncs data, and publishes without overwriting. An existing archive filename succeeds only when contents match. PostgreSQL retries failures. `archive_timeout=60s` encourages segment rotation but does not guarantee a 60-second recovery point: failures, archive lag and missing segments matter. Inspect `pg_stat_archiver`, archive space and continuity, and alert on archive failures before relying on it. Current application alerts do not monitor backup storage capacity or archiver lag.

Backups are manual in this local milestone. There is no automatic expiry: deleting WAL independently can break the chain needed by a retained backup. Before hosting, define a tested schedule, retain at least one verified base backup plus every required WAL segment for the chosen recovery window, preserve timeline history, copy to encrypted independent storage, restrict access, and test retrieval. A successful local manifest check is not proof that off-site recovery works. Keep infrastructure/configuration and scoped secrets recoverable separately; WAL does not restore later configuration-file edits.

## Repeat the real restore drill

Build the staging image first, then:

```powershell
npm run restore:drill
```

The runner creates uniquely labelled disposable source/target containers, a private network and four new volumes. It never restores over development or staging. It:

1. Migrates an empty synthetic source and seeds pending work, an old lease, accepted and uncertain sends, model usage, and an account to delete.
2. Takes and verifies a physical base backup.
3. Inserts an after-backup marker, creates a named restore point, inserts a later marker, and confirms WAL archival.
4. Deletes the synthetic account **after** the restore point and captures a fresh deletion overlay.
5. Copies the base backup into a new empty volume; uses `recovery.signal`, archive replay and `recovery_target_action=pause` to stop at the named point.
6. Confirms the first marker exists and the later one does not, then promotes the isolated clone.
7. Applies quarantine, fences old leases, preserves accepted sends, holds unknown outcomes, settles synthetic usage, abandons the synthetic unknown send without retrying, and reapplies/purges the later account deletion.
8. Explicitly releases the reviewed restore, verifies pending work can be claimed and spending remains paused, then removes only the drill's labelled containers/network/volumes.

The ignored `.restore-drills/<id>/report.json` records the exact application image ID, source system identifier, selected point, timing and assertions. Private files in that folder include synthetic credentials and deletion evidence: never commit the whole folder. The sanitized successful [M3-04 report](evidence/m3-04-restore.json) is checked into the working tree. A CI job repeats this drill; this document records local results and does not assert a remote CI outcome.

The report's elapsed time is one tiny local sample. It is not a production recovery objective or load measurement. No external calls are made and provider reconciliation evidence is synthetic.

## Operator recovery contract

For a real incident, preserve the source and its volumes. Stop affected API/workers and keep paid dispatch paused. Obtain the latest deletion evidence and external-operation records independently of the old backup. Do not start ordinary services on the restored database before review.

Use an isolated, unpublished target with a new data volume. Select a verified base backup and continuous WAL chain; use the same PostgreSQL major version and required extensions. Mount the archive read-only on the target and disable target archiving into the source archive. Configure these **server startup** settings before it first accepts connections:

```text
restore_command = 'cp /wal-archive/%f %p'
recovery_target_name = '<recorded restore point>'
recovery_target_action = 'pause'
memorae.recovery_target = 'on'
memorae.recovery_instance = '<new UUID for this restore>'
```

Create `recovery.signal` in the new data directory. Validate that replay paused at the intended point, then promote the isolated target. `scripts/restore-drill.ts` is the executable reference for copying, configuring and checking the synthetic target. Do not use the fixture seed/verification commands against real data.

Every restore needs a **fresh instance UUID**, even if its backup came from a previously restored database. Migration 0021 prevents an approval copied inside a backup from releasing a different restore. A missing instance also stays blocked. Keep both custom settings on the server throughout operation of that recovered instance. These settings and network isolation are administrator responsibilities; the application cannot recognize an unmarked physical clone. The gate protects the normal API/worker paths, not malicious administrators or arbitrary direct SQL.

With a protected administrator URL for the appropriate database, the commands are:

```text
npm run restore:control -- overlay <new-private-overlay.json>              # latest trusted source
npm run restore:control -- quarantine <private-overlay.json> <system-id>   # isolated target
npm run restore:control -- status                                        # isolated target
npm run restore:control -- release <private-review.json>                  # isolated target, last step
```

When running outside Docker, set `DATABASE_URL_FILE` to an absolute protected file path and ensure a direct `DATABASE_URL` is absent, including from `.env`. Inside the image, use `node dist/ops/recovery.js` with the same arguments and a file-mounted administrator secret. Do not put database credentials into command lines.

The overlay contains keyed deletion fingerprints, database name, PostgreSQL system identifier, capture time and a digest of the privacy key; it contains no raw address or key. It includes both erased accounts and confirmed deletions awaiting purge. Matching identity/key checks and a 24-hour freshness limit prevent accidental use of unrelated or stale evidence. It is trusted administrator input, not a signed proof of completeness. Keep a durable, securely replicated deletion journal before accepting real users. If the latest deletion evidence is lost with the source, recovering the old backup alone cannot establish that every deletion has been reapplied.

Quarantine atomically pauses spending, merges deletion fingerprints, cancels affected activity, invalidates old lease tokens, turns dispatching sends/model calls into unknown outcomes, exhausts waiting retries, and records an audit. It blocks ingress readiness/persistence, new worker claims/commits, scheduling and paid dispatch. Inspect diagnostics and reconcile while blocked. Accepted sends remain accepted. Run the established [usage](usage-controls.md), [delivery](delivery-recovery.md) and [privacy](privacy.md) controls to resolve holds and purge confirmed accounts.

Review the entire interval between the restore point and incident. A provider may have accepted a message during that interval while the restored database has **no record** of it. Checking only restored unknown rows is insufficient. Reconcile provider receipts/records and independent logs; cancel or hold pending work when evidence cannot rule out a duplicate. Never blindly retry unknown sends. Existing deadline and evidence requirements still apply during recovery.

The release review file must contain the current quarantine session ID and these explicit confirmations:

```json
{
  "sessionId": "<UUID returned by quarantine>",
  "externalOutcomesReviewed": true,
  "pendingWorkReviewed": true,
  "deletionRecordsReviewed": true
}
```

Release checks the target instance, session, fresh overlay, paused spending, unresolved usage/sends, late acceptance conflicts and pending deletions. A new quarantine supersedes an old review. Confirmation flags record operator responsibility; they cannot prove provider outcomes missing from the backup. Release leaves spending paused. Start services, verify readiness and monitor health, and resume only explicitly reviewed capabilities after all launch prerequisites pass.
