import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { measure, summarize } from '../../scripts/lib/load.js';
import {
  assessQualification,
  launchReadiness,
  scenarioIds,
  manualGateIds,
  type QualificationReport,
} from '../../src/modules/qualification/report.js';

const now = new Date('2026-10-29T12:00:00.000Z'),
  image = 'sha256:' + 'a'.repeat(64);
function report(): QualificationReport {
  return {
    version: 'qualification-v1',
    id: '123456789abc',
    createdAt: now.toISOString(),
    imageId: image,
    revision: 'test',
    syntheticOnly: true,
    externalProviderCalls: 0,
    cleanupPassed: true,
    scenarios: scenarioIds.map((id) => ({ id, passed: true, milliseconds: 10 })),
    profiles: (
      [
        { name: 'serial', concurrency: 1, requests: 60 },
        { name: 'concurrent', concurrency: 8, requests: 240 },
      ] as const
    ).map((p) => ({
      ...p,
      successes: p.requests,
      statuses: { '200': p.requests },
      elapsedMs: 1000,
      requestsPerSecond: p.requests,
      latencyMs: { p50: 10, p95: 20, p99: 30, max: 40 },
      persisted: p.requests,
      completed: p.requests,
      drainMs: 1000,
    })),
  };
}
const reviews = () => ({
  version: 'launch-reviews-v1',
  reviews: manualGateIds.map((id) => ({
    id,
    status: 'verified',
    owner: 'test operator',
    evidence: 'synthetic test only',
    reviewedAt: now.toISOString(),
    imageId: image,
  })),
});
test('load measurement counts failures, bounds concurrency and never retries requests', async () => {
  let active = 0,
    max = 0;
  const seen: number[] = [];
  const result = await measure(20, 3, async (i) => {
    seen.push(i);
    active++;
    max = Math.max(max, active);
    await setTimeout(2);
    active--;
    if (i === 0) throw new Error('private transport detail');
    return i === 1 ? 503 : 200;
  });
  assert.equal(result.requests, 20);
  assert.equal(result.successes, 18);
  assert.equal(result.statuses.transport_error, 1);
  assert.equal(result.statuses['503'], 1);
  assert.ok(max <= 3);
  assert.equal(new Set(seen).size, 20);
  await assert.rejects(measure(1001, 2, async () => 200));
  await assert.rejects(measure(1, 33, async () => 200));
});
test('nearest-rank percentiles include every failed request and use the full measurement duration', () => {
  const result = summarize(
    Array.from({ length: 100 }, (_, i) => ({ milliseconds: i + 1, status: i === 99 ? null : 200 })),
    2000,
  );
  assert.deepEqual(result.latencyMs, { p50: 50, p95: 95, p99: 99, max: 100 });
  assert.equal(result.requestsPerSecond, 50);
  assert.equal(result.successes, 99);
  assert.throws(() => summarize([], 1));
  assert.throws(() => summarize([{ milliseconds: NaN, status: 200 }], 1));
});
test('qualification cannot pass omitted, duplicate or failed scenarios or incomplete loads', () => {
  assert.deepEqual(assessQualification(report()), {
    functionalPassed: true,
    performancePassed: true,
  });
  for (const mutate of [
    (r: QualificationReport) => r.scenarios.pop(),
    (r: QualificationReport) => {
      r.scenarios[0] = r.scenarios[1]!;
    },
    (r: QualificationReport) => {
      r.scenarios[0]!.passed = false;
    },
    (r: QualificationReport) => {
      r.cleanupPassed = false;
    },
    (r: QualificationReport) => {
      r.profiles[0]!.completed--;
    },
    (r: QualificationReport) => {
      r.profiles[0]!.statuses['503'] = 1;
    },
    (r: QualificationReport) => {
      r.profiles[1]!.concurrency = 1;
    },
  ]) {
    const r = report();
    mutate(r);
    assert.equal(assessQualification(r).functionalPassed, false);
  }
});
test('latency or drain target failures remain visible separately from functional correctness', () => {
  const r = report();
  r.profiles[0]!.latencyMs.p99 = 250;
  r.profiles[0]!.latencyMs.max = 300;
  assert.deepEqual(assessQualification(r), { functionalPassed: true, performancePassed: false });
  const slow = report();
  slow.profiles[1]!.drainMs = 60001;
  assert.equal(assessQualification(slow).performancePassed, false);
});
test('launch blocks stale, future, wrong-image, missing and unreviewed evidence', () => {
  assert.equal(launchReadiness(report(), reviews(), image, now).ready, true);
  for (const change of [
    (r: QualificationReport) => {
      r.createdAt = '2026-10-01T00:00:00.000Z';
    },
    (r: QualificationReport) => {
      r.createdAt = '2026-10-30T00:00:00.000Z';
    },
    (r: QualificationReport) => {
      r.imageId = 'sha256:' + 'b'.repeat(64);
    },
  ]) {
    const r = report();
    change(r);
    assert.equal(launchReadiness(r, reviews(), image, now).ready, false);
  }
  for (const alter of [
    (r: ReturnType<typeof reviews>) => r.reviews.pop(),
    (r: ReturnType<typeof reviews>) => {
      r.reviews[0]!.status = 'pending';
    },
    (r: ReturnType<typeof reviews>) => {
      r.reviews[0]!.evidence = '';
    },
    (r: ReturnType<typeof reviews>) => {
      r.reviews[0]!.owner = '';
    },
    (r: ReturnType<typeof reviews>) => {
      r.reviews[0]!.imageId = 'old';
    },
    (r: ReturnType<typeof reviews>) => {
      r.reviews[0]!.reviewedAt = '2026-10-01T00:00:00.000Z';
    },
    (r: ReturnType<typeof reviews>) => {
      r.reviews.push(r.reviews[0]!);
    },
  ]) {
    const rev = reviews();
    alter(rev);
    assert.equal(launchReadiness(report(), rev, image, now).ready, false);
  }
  assert.throws(() => launchReadiness({ passed: true }, reviews(), image, now));
});
