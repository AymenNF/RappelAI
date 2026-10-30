export const rules = {
  backup_overdue: {
    severity: 'critical',
    action:
      'No recent manifest-verified base backup with archived WAL. Run/check staging:backup; keep launch blocked and verify storage separately.',
  },
  backup_failed: {
    severity: 'critical',
    action:
      'A backup failed after the last verified backup. Inspect the private backup run and storage, repair the cause and create a fresh verified backup.',
  },
  backup_stalled: {
    severity: 'critical',
    action:
      'A backup exceeded its duration limit. Inspect its process before marking the overdue run abandoned; do not delete backup or WAL files.',
  },
  archive_disabled: {
    severity: 'critical',
    action:
      'Expected PostgreSQL WAL archiving is disabled. Restore the reviewed archive configuration and test recovery before launch.',
  },
  archive_failed: {
    severity: 'critical',
    action:
      'The latest recorded archive failure has no later success. Inspect archiver/storage health and pending WAL; never infer archive continuity from the last filename.',
  },
  archive_stalled: {
    severity: 'critical',
    action:
      'WAL has waited beyond the archive limit. Inspect archive command, permissions and disk capacity; preserve the WAL chain.',
  },
  backup_probe_failed: {
    severity: 'critical',
    action:
      'Archive health could not be observed. Check the restricted probe/provider monitoring capability; unavailable evidence is not a healthy archive.',
  },
  api_missing: {
    severity: 'critical',
    action:
      'API heartbeat missing or older than 120s. Check the API process, telemetry flush and database connectivity.',
  },
  worker_missing: {
    severity: 'critical',
    action:
      'Worker heartbeat missing or older than 120s. Check process health and cycle duration before restarting.',
  },
  api_errors: {
    severity: 'critical',
    action:
      'Webhook 5xx in the last five minutes. Check database health; keep failed persistence retryable.',
  },
  api_overload: {
    severity: 'warning',
    action:
      'Webhook capacity rejections in the last five minutes. Inspect queue growth and worker throughput.',
  },
  api_slow: {
    severity: 'warning',
    action:
      'Webhook responses exceeded one second in the last five minutes. Inspect database/pool latency; this is not a p99 estimate.',
  },
  worker_errors: {
    severity: 'critical',
    action:
      'Worker cycle failures in the last five minutes. Inspect database availability and the affected queues.',
  },
  work_stalled: {
    severity: 'warning',
    action:
      'Runnable work is over 60s old. Inspect ops:control queue work; check paused/disabled planning and earlier ordered work.',
  },
  work_dead: {
    severity: 'critical',
    action:
      'Dead work blocks its stream. Inspect ops:control queue work; repair the cause before work:retry.',
  },
  lease_expired: {
    severity: 'warning',
    action: 'Expired work leases await recovery. Check worker progress; never reuse an old lease.',
  },
  model_unresolved: {
    severity: 'critical',
    action:
      'Model reservations remain reserved/dispatched/unknown after 300s. Inspect ops:control queue model and usage:control status; reconcile evidence, never infer zero usage from age.',
  },
  send_unknown: {
    severity: 'critical',
    action:
      'Unknown sends remain unresolved after 300s. Inspect ops:control queue send and delivery:control status; use provider evidence, never blind retry.',
  },
  send_expired: {
    severity: 'critical',
    action:
      'A send passed its dispatch deadline. Run/check delivery recovery; expiry means unknown, not safe to resend.',
  },
  send_failed: {
    severity: 'warning',
    action:
      'Terminal send rejection/failure in the last 24h. Inspect delivery:control status and templates/credentials before any intentional retry.',
  },
  send_conflict: {
    severity: 'critical',
    action:
      'Late acceptance conflicts with a prior send decision. Keep sending paused and reconcile provider evidence via delivery:control.',
  },
  reminders_late: {
    severity: 'warning',
    action:
      'Unscheduled reminders are over 60s past due. Inspect scheduler health and identity gates.',
  },
  outbound_late: {
    severity: 'warning',
    action:
      'Pending outbound intents are over 60s past their promised availability without an accepted/in-flight/unknown attempt. Check sending activation, templates, quotas and spend pause; do not change the promise.',
  },
  receipts_unmatched: {
    severity: 'warning',
    action:
      'Receipts are unmatched after 300s. Inspect ops:control queue receipt and provider evidence; do not attach them to a guessed account.',
  },
  privacy_waiting: {
    severity: 'warning',
    action:
      'Confirmed deletion waits over one hour. Inspect ops:control queue privacy and usage/delivery holds before privacy:control purge.',
  },
  spend_near_cap: {
    severity: 'warning',
    action:
      'Reserved plus spent usage reached 90% of the enabled global monthly cap. Inspect usage:control status; do not raise limits automatically.',
  },
} as const;
export type AlertKey = keyof typeof rules;
export type Signals = Record<AlertKey, number>;
export function activeRules(signals: Signals) {
  return (Object.keys(rules) as AlertKey[]).filter((key) => {
    if (!Number.isSafeInteger(signals[key]) || signals[key] < 0)
      throw new Error('Invalid monitoring signal');
    return signals[key] > 0;
  });
}
