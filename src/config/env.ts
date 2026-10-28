import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z
    .string()
    .url()
    .refine((v) => /^postgres(ql)?:/.test(v))
    .optional(),
  WHATSAPP_APP_SECRET: z
    .string()
    .min(16)
    .refine((v) => !v.startsWith('replace-')),
  WHATSAPP_VERIFY_TOKEN: z
    .string()
    .min(16)
    .refine((v) => !v.startsWith('replace-')),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(30000),
});

export type Config = z.infer<typeof schema>;
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Do not include environment values or database credentials in error messages.
    throw new Error(
      `Invalid configuration: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  return result.data;
}
