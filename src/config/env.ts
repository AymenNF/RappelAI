import 'dotenv/config';
import { z } from 'zod';
import { readSecret } from './secrets.js';

const common = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DEPLOYMENT_ENV: z.enum(['local', 'staging', 'production']).default('local'),
  STAGING_SYNTHETIC_ONLY: z.enum(['true', 'false']).default('false'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z
    .string()
    .url()
    .refine((v) => /^postgres(ql)?:/.test(v))
    .optional(),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(30000),
  MODEL_MODE: z.enum(['disabled', 'fixture']).default('disabled'),
  MODEL_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(20000),
});
const schema = common.extend({
  WHATSAPP_APP_SECRET: z
    .string()
    .min(16)
    .refine((v) => !v.startsWith('replace-')),
  WHATSAPP_VERIFY_TOKEN: z
    .string()
    .min(16)
    .refine((v) => !v.startsWith('replace-')),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
});

export function assertDeployment(config: z.infer<typeof common>) {
  if (
    config.DEPLOYMENT_ENV === 'production' ||
    (config.NODE_ENV === 'production' && config.DEPLOYMENT_ENV !== 'staging')
  )
    throw new Error('Production activation requires qualified consent and provider configuration');
  if (
    config.DEPLOYMENT_ENV === 'staging' &&
    (config.STAGING_SYNTHETIC_ONLY !== 'true' || config.MODEL_MODE !== 'disabled')
  )
    throw new Error('Staging is synthetic-only with model processing disabled');
}
export function readWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = common.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid worker configuration: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  assertDeployment(result.data);
  return result.data;
}

export type Config = z.infer<typeof schema>;
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse({
    ...env,
    WHATSAPP_APP_SECRET: readSecret('WHATSAPP_APP_SECRET', env),
    WHATSAPP_VERIFY_TOKEN: readSecret('WHATSAPP_VERIFY_TOKEN', env),
  });
  if (!result.success) {
    // Do not include environment values or database credentials in error messages.
    throw new Error(
      `Invalid configuration: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  assertDeployment(result.data);
  if (
    result.data.DEPLOYMENT_ENV === 'staging' &&
    result.data.WHATSAPP_PHONE_NUMBER_ID !== 'staging-synthetic'
  )
    throw new Error('Staging requires the synthetic business phone allowlist');
  return result.data;
}
