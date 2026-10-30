export type BackupFailure =
  'backup_failed' | 'manifest_failed' | 'archive_timeout' | 'evidence_failed';
export async function verifiedBackup(steps: {
  start(): Promise<void>;
  create(): Promise<void>;
  verifyManifest(): Promise<void>;
  archiveWal(): Promise<void>;
  saveEvidence(): Promise<void>;
  finish(state: 'verified' | 'failed', reason: BackupFailure | null): Promise<void>;
}) {
  // If registration fails, do not start an untracked backup.
  await steps.start();
  let phase: BackupFailure = 'backup_failed';
  try {
    await steps.create();
    phase = 'manifest_failed';
    await steps.verifyManifest();
    phase = 'archive_timeout';
    await steps.archiveWal();
    phase = 'evidence_failed';
    await steps.saveEvidence();
    await steps.finish('verified', null);
  } catch {
    // Preserve a running row if the database cannot acknowledge the failure.
    // Its duration alarm will require reconciliation, not a fabricated success.
    await steps.finish('failed', phase).catch(() => {});
    throw new Error(
      `Backup verification failed: ${phase}. Inspect the private run; no success is asserted.`,
    );
  }
}
