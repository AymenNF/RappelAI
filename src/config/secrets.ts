import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/** Read one secret, never include its value or filename in an error. */
export function readSecret(key: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct = env[key],
    file = env[`${key}_FILE`];
  if (direct !== undefined && file !== undefined) throw new Error(`Ambiguous secret: ${key}`);
  if (!file) return direct;
  try {
    if (!isAbsolute(file) || !statSync(file).isFile() || statSync(file).size > 16384)
      throw new Error();
    const value = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    if (!value || /[\r\n\0]/.test(value)) throw new Error();
    return value;
  } catch {
    throw new Error(`Cannot read secret: ${key}`);
  }
}

export function assertSecretScope(
  component: 'api' | 'worker' | 'monitor',
  env: NodeJS.ProcessEnv = process.env,
) {
  if (env.DEPLOYMENT_ENV !== 'staging') return;
  const allowed = {
    api: ['INGRESS_DATABASE_URL', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN'],
    worker: ['WORKER_DATABASE_URL'],
    monitor: ['MONITOR_DATABASE_URL'],
  }[component];
  for (const key of [
    'DATABASE_URL',
    'INGRESS_DATABASE_URL',
    'WORKER_DATABASE_URL',
    'TENANT_DATABASE_URL',
    'MONITOR_DATABASE_URL',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_VERIFY_TOKEN',
    'MODEL_API_KEY',
    'WHATSAPP_ACCESS_TOKEN',
  ]) {
    if (!allowed.includes(key) && (env[key] !== undefined || env[`${key}_FILE`] !== undefined))
      throw new Error(`Secret outside ${component} scope: ${key}`);
  }
  for (const key of allowed)
    if (env[key] !== undefined || !env[`${key}_FILE`])
      throw new Error(`Staging requires mounted secret: ${key}`);
}
