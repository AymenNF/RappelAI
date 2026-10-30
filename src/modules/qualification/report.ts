import { z } from 'zod';
export const scenarioIds = [
  'signed_replay',
  'database_outage',
  'api_restart',
  'transaction_crash',
  'post_commit_crash',
  'unknown_send_crash',
  'monitor_recovery',
  'load_drain',
] as const;
const nonnegative = z.number().finite().nonnegative();
export const qualificationReport = z
  .object({
    version: z.literal('qualification-v1'),
    id: z.string().regex(/^[a-f0-9]{12}$/),
    createdAt: z.iso.datetime(),
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    revision: z.string().min(1),
    syntheticOnly: z.literal(true),
    externalProviderCalls: z.literal(0),
    scenarios: z.array(
      z
        .object({ id: z.enum(scenarioIds), passed: z.boolean(), milliseconds: nonnegative })
        .strict(),
    ),
    profiles: z.array(
      z
        .object({
          name: z.enum(['serial', 'concurrent']),
          concurrency: z.number().int().min(1).max(32),
          requests: z.number().int().min(1).max(1000),
          successes: z.number().int().nonnegative(),
          statuses: z.record(z.string(), z.number().int().nonnegative()),
          elapsedMs: nonnegative,
          requestsPerSecond: nonnegative,
          latencyMs: z
            .object({ p50: nonnegative, p95: nonnegative, p99: nonnegative, max: nonnegative })
            .strict(),
          persisted: z.number().int().nonnegative(),
          completed: z.number().int().nonnegative(),
          drainMs: nonnegative,
        })
        .strict(),
    ),
    cleanupPassed: z.boolean(),
  })
  .strict();
export type QualificationReport = z.infer<typeof qualificationReport>;
export const manualGateIds = [
  'regression_suite',
  'live_model_evaluation',
  'provider_templates_delivery',
  'production_privacy',
  'hosted_security',
  'offsite_restore',
  'paging_and_ownership',
  'beta_rollout',
] as const;
export const reviewsSchema = z
  .object({
    version: z.literal('launch-reviews-v1'),
    reviews: z.array(
      z
        .object({
          id: z.enum(manualGateIds),
          status: z.enum(['pending', 'verified']),
          owner: z.string(),
          evidence: z.string(),
          reviewedAt: z.iso.datetime().nullable(),
          imageId: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export function assessQualification(input: unknown) {
  const r = qualificationReport.parse(input);
  const scenariosPassed =
    r.scenarios.length === scenarioIds.length &&
    scenarioIds.every((id) => r.scenarios.filter((s) => s.id === id && s.passed).length === 1);
  const completeProfiles =
    r.profiles.length === 2 &&
    ['serial', 'concurrent'].every(
      (name) => r.profiles.filter((p) => p.name === name).length === 1,
    );
  const loadIntegrity =
    completeProfiles &&
    r.profiles.every((p) => {
      const counts = Object.values(p.statuses).reduce((a, b) => a + b, 0);
      return (
        counts === p.requests &&
        p.statuses['200'] === p.requests &&
        p.successes === p.requests &&
        p.persisted === p.requests &&
        p.completed === p.requests &&
        p.elapsedMs > 0 &&
        p.latencyMs.p50 <= p.latencyMs.p95 &&
        p.latencyMs.p95 <= p.latencyMs.p99 &&
        p.latencyMs.p99 <= p.latencyMs.max &&
        (p.name === 'serial'
          ? p.concurrency === 1 && p.requests >= 60
          : p.concurrency >= 8 && p.requests >= 240)
      );
    });
  return {
    functionalPassed: scenariosPassed && loadIntegrity && r.cleanupPassed,
    performancePassed:
      loadIntegrity && r.profiles.every((p) => p.latencyMs.p99 < 200 && p.drainMs <= 60000),
  };
}

export function launchReadiness(
  input: unknown,
  reviews: unknown,
  expectedImage: string,
  now = new Date(),
) {
  const r = qualificationReport.parse(input),
    review = reviewsSchema.parse(reviews),
    assessment = assessQualification(r);
  const age = now.getTime() - Date.parse(r.createdAt);
  const checks = [
    {
      id: 'evidence_identity_freshness',
      passed: r.imageId === expectedImage && age >= -300000 && age <= 7 * 86400000,
    },
    { id: 'local_failure_and_load_integrity', passed: assessment.functionalPassed },
    { id: 'local_latency_and_drain_target', passed: assessment.performancePassed },
    ...manualGateIds.map((id) => {
      const matches = review.reviews.filter((v) => v.id === id),
        v = matches[0];
      const reviewAge = v?.reviewedAt ? now.getTime() - Date.parse(v.reviewedAt) : Infinity;
      return {
        id,
        passed:
          matches.length === 1 &&
          v!.status === 'verified' &&
          !!v!.owner.trim() &&
          !!v!.evidence.trim() &&
          v!.imageId === expectedImage &&
          reviewAge >= -300000 &&
          reviewAge <= 7 * 86400000,
      };
    }),
  ];
  return {
    version: 'launch-readiness-v1',
    imageId: expectedImage,
    ready: checks.every((g) => g.passed),
    checks,
    note: 'Operator attestations require supporting evidence; this report does not activate providers or approve deployment.',
  };
}
