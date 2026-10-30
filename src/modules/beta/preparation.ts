import { z } from 'zod';
import { launchReadiness } from '../qualification/report.js';
export const betaPlan = z
  .object({
    version: z.literal('beta-plan-v1'),
    mode: z.literal('preparation_only'),
    initialParticipants: z.number().int().min(1).max(5),
    maximumParticipants: z.number().int().min(1).max(20),
    operator: z.string().max(100),
    incidentOwner: z.string().max(100),
    supportChannel: z.string().max(200),
    dailyReviewTimeUtc: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    dailyModelReviewMicros: z.string().regex(/^(0|[1-9]\d{0,29})$/),
    cohortAliases: z.array(z.string().regex(/^beta-\d{2}$/)).max(20),
    rolloutApproval: z
      .object({
        approved: z.boolean(),
        imageId: z.string().nullable(),
        approvedAt: z.iso.datetime().nullable(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (p) =>
      p.initialParticipants <= p.maximumParticipants &&
      p.cohortAliases.length <= p.initialParticipants &&
      new Set(p.cohortAliases).size === p.cohortAliases.length,
    'Invalid cohort bounds',
  );
export function prepareBeta(
  plan: unknown,
  report: unknown,
  reviews: unknown,
  image: string,
  now = new Date(),
) {
  const p = betaPlan.parse(plan),
    readiness = launchReadiness(report, reviews, image, now);
  const age = p.rolloutApproval.approvedAt
    ? now.getTime() - Date.parse(p.rolloutApproval.approvedAt)
    : Infinity;
  const planChecks = [
    {
      id: 'beta_responsibilities',
      passed: !!p.operator.trim() && !!p.incidentOwner.trim() && !!p.supportChannel.trim(),
    },
    { id: 'beta_cohort_prepared', passed: p.cohortAliases.length > 0 },
    {
      id: 'beta_owner_approval',
      passed:
        p.rolloutApproval.approved &&
        p.rolloutApproval.imageId === image &&
        age >= -300000 &&
        age <= 7 * 86400000,
    },
  ];
  return {
    version: 'beta-preparation-v1',
    imageId: image,
    mode: p.mode,
    readyForOwnerLaunchReview: readiness.ready && planChecks.every((c) => c.passed),
    launchEnabled: false,
    checks: [...readiness.checks, ...planChecks],
    note: 'Preparation does not send invitations, enroll users, activate providers or enable spending. Complete readiness and obtain explicit launch authorization.',
  };
}
