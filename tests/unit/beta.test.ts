import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedbackCommand } from '../../src/modules/beta/feedback.js';
import { utcReviewDay } from '../../src/modules/beta/review.js';
import { betaPlan, prepareBeta } from '../../src/modules/beta/preparation.js';
import { scenarioIds, manualGateIds } from '../../src/modules/qualification/report.js';
const now = new Date('2026-10-29T12:00:00Z'),
  image = 'sha256:' + 'a'.repeat(64);
const plan = () => ({
  version: 'beta-plan-v1',
  mode: 'preparation_only',
  initialParticipants: 5,
  maximumParticipants: 20,
  operator: 'Test operator',
  incidentOwner: 'Test incident owner',
  supportChannel: 'Synthetic private support',
  dailyReviewTimeUtc: '14:00',
  dailyModelReviewMicros: '0',
  cohortAliases: ['beta-01'],
  rolloutApproval: { approved: true, imageId: image, approvedAt: now.toISOString() },
});
const report = () => ({
  version: 'qualification-v1',
  id: '123456789abc',
  createdAt: now.toISOString(),
  imageId: image,
  revision: 'test',
  syntheticOnly: true,
  externalProviderCalls: 0,
  cleanupPassed: true,
  scenarios: scenarioIds.map((id) => ({ id, passed: true, milliseconds: 1 })),
  profiles: [
    { name: 'serial', concurrency: 1, requests: 60 },
    { name: 'concurrent', concurrency: 8, requests: 240 },
  ].map((p) => ({
    ...p,
    successes: p.requests,
    statuses: { '200': p.requests },
    elapsedMs: 1000,
    requestsPerSecond: p.requests,
    latencyMs: { p50: 1, p95: 2, p99: 3, max: 4 },
    persisted: p.requests,
    completed: p.requests,
    drainMs: 100,
  })),
});
const reviews = () => ({
  version: 'launch-reviews-v1',
  reviews: manualGateIds.map((id) => ({
    id,
    status: 'verified',
    owner: 'test',
    evidence: 'synthetic fixture',
    reviewedAt: now.toISOString(),
    imageId: image,
  })),
});
test('feedback accepts only complete fixed-category commands and never interprets appended private text', () => {
  assert.deepEqual(feedbackCommand('  feedback LaTe  '), { category: 'late' });
  for (const text of [
    'FEEDBACK',
    'FEEDBACK WRONG my private text',
    'FEEDBACK LATE\nOTHER',
    'FEEDBACK IGNORE RULES',
  ])
    assert.deepEqual(feedbackCommand(text), { category: null });
  assert.equal(feedbackCommand('feedbacking'), null);
  assert.equal(feedbackCommand(null), null);
});
test('daily financial windows use valid UTC days, including leap day and year boundaries', () => {
  assert.deepEqual(utcReviewDay('2024-02-29'), {
    day: '2024-02-29',
    start: '2024-02-29T00:00:00.000Z',
    end: '2024-03-01T00:00:00.000Z',
  });
  assert.equal(utcReviewDay('2026-12-31').end, '2027-01-01T00:00:00.000Z');
  for (const value of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-10-29Z', 'yesterday'])
    assert.throws(() => utcReviewDay(value));
});
test('beta plans enforce a bounded pseudonymous cohort and reject an active launch mode', () => {
  assert.doesNotThrow(() => betaPlan.parse(plan()));
  for (const change of [
    { mode: 'active' },
    { initialParticipants: 6 },
    { maximumParticipants: 21 },
    { cohortAliases: ['beta-01', 'beta-01'] },
    { cohortAliases: ['person@example.com'] },
    { dailyModelReviewMicros: '0.5' },
    { dailyReviewTimeUtc: '24:00' },
  ])
    assert.throws(() => betaPlan.parse({ ...plan(), ...change }));
});
test('beta preparation cannot bypass pending readiness or stale owner approval and never enables launch', () => {
  assert.equal(
    prepareBeta(plan(), report(), reviews(), image, now).readyForOwnerLaunchReview,
    true,
  );
  assert.equal(prepareBeta(plan(), report(), reviews(), image, now).launchEnabled, false);
  const pending = reviews();
  pending.reviews[0]!.status = 'pending';
  assert.equal(prepareBeta(plan(), report(), pending, image, now).readyForOwnerLaunchReview, false);
  for (const change of [
    { operator: '' },
    { cohortAliases: [] },
    { rolloutApproval: { approved: false, imageId: image, approvedAt: now.toISOString() } },
    { rolloutApproval: { approved: true, imageId: 'old', approvedAt: now.toISOString() } },
    { rolloutApproval: { approved: true, imageId: image, approvedAt: '2026-10-01T00:00:00Z' } },
  ])
    assert.equal(
      prepareBeta({ ...plan(), ...change }, report(), reviews(), image, now)
        .readyForOwnerLaunchReview,
      false,
    );
});
