import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { hashText } from '../src/modules/processing/prompt.js';
import { loadDataset } from './lib.js';
import { predictionSchema, score } from './metrics.js';

export async function verifyReport(directory: string) {
  const dataset = await loadDataset();
  const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (
    report.formatVersion !== 'eval-report-v1' ||
    report.scorerVersion !== 'decision-score-v1' ||
    manifest.runId !== report.runId ||
    manifest.dataset.sha256 !== dataset.hash ||
    manifest.dataset.version !== dataset.version
  )
    throw new Error('Report/dataset version mismatch');
  for (const [key, value] of Object.entries(manifest))
    if (JSON.stringify(report[key]) !== JSON.stringify(value))
      throw new Error('Manifest/report mismatch');
  const split = z.enum(['all', 'development', 'holdout']).parse(manifest.dataset.split);
  const cases = dataset.cases.filter((c) => split === 'all' || c.split === split);
  if (JSON.stringify(cases.map((c) => c.id)) !== JSON.stringify(manifest.dataset.caseIds))
    throw new Error('Report case selection mismatch');
  const predictionsText = await readFile(join(directory, 'predictions.jsonl'), 'utf8');
  if (
    hashText(predictionsText) !== report.predictionsSha256 ||
    hashText(await readFile(join(directory, 'prompt.txt'), 'utf8')) !== manifest.prompt.sha256 ||
    hashText(JSON.stringify(JSON.parse(await readFile(join(directory, 'schema.json'), 'utf8')))) !==
      manifest.schema.sha256
  )
    throw new Error('Report artifact checksum mismatch');
  const rows = predictionsText.trim()
    ? predictionsText
        .trim()
        .split(/\r?\n/)
        .map((line) => predictionSchema.parse(JSON.parse(line)))
    : [];
  const source = z.enum(['openai', 'mock']).parse(manifest.source);
  const metrics = score(cases, rows, source);
  const gatePassed =
    source === 'openai' && split === 'all' && report.stopReason === 'completed' && metrics.passed;
  if (
    JSON.stringify(metrics) !== JSON.stringify(report.metrics) ||
    gatePassed !== report.gatePassed
  )
    throw new Error('Report metrics mismatch');
  return { source, metrics, gatePassed };
}
