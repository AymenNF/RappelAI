export type Sample = { milliseconds: number; status: number | null };
export function summarize(samples: Sample[], elapsedMs: number) {
  if (
    !samples.length ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0 ||
    samples.some((s) => !Number.isFinite(s.milliseconds) || s.milliseconds < 0)
  )
    throw new Error('Invalid measurement');
  const sorted = samples.map((s) => s.milliseconds).sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
  const statuses: Record<string, number> = {};
  for (const sample of samples) {
    const key = sample.status === null ? 'transport_error' : String(sample.status);
    statuses[key] = (statuses[key] ?? 0) + 1;
  }
  return {
    requests: samples.length,
    successes: samples.filter((s) => s.status === 200).length,
    statuses,
    elapsedMs,
    requestsPerSecond: (samples.length * 1000) / elapsedMs,
    latencyMs: {
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: sorted.at(-1)!,
    },
  };
}

/** Closed-loop bounded concurrency; errors stay in the denominator. No automatic retries. */
export async function measure(
  requests: number,
  concurrency: number,
  send: (index: number) => Promise<number>,
) {
  if (
    !Number.isInteger(requests) ||
    requests < 1 ||
    requests > 1000 ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 32
  )
    throw new Error('Load bounds exceeded');
  let next = 0;
  const samples: Sample[] = new Array(requests);
  const began = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(requests, concurrency) }, async () => {
      while (next < requests) {
        const index = next++,
          start = performance.now();
        let status: number | null = null;
        try {
          status = await send(index);
        } catch {
          /* Retain the failed request, without raw errors. */
        }
        samples[index] = { milliseconds: performance.now() - start, status };
      }
    }),
  );
  return summarize(samples, performance.now() - began);
}
