import type { Pool } from 'pg';
import { withTenant } from '../../db/tenant.js';

export class TenantProfiles {
  constructor(private readonly pool: Pool) {}

  async get(authenticatedUserId: string) {
    return withTenant(this.pool, authenticatedUserId, async (client) => {
      const result = await client.query(`SELECT u.id,u.timezone,u.timezone_confirmed_at,u.paused,
        u.consent_version,COALESCE(p.reply_language,'en') AS reply_language
        FROM users u LEFT JOIN user_preferences p ON p.user_id=u.id`);
      return result.rows[0] ?? null;
    });
  }

  async setReplyLanguage(authenticatedUserId: string, language: string): Promise<void> {
    if (!['en', 'fr', 'es'].includes(language)) throw new Error('Unsupported reply language');
    await withTenant(this.pool, authenticatedUserId, async (client) => {
      await client.query(
        `INSERT INTO user_preferences(user_id,reply_language) VALUES($1,$2)
        ON CONFLICT(user_id) DO UPDATE SET reply_language=EXCLUDED.reply_language,updated_at=now()`,
        [authenticatedUserId, language],
      );
    });
  }
}
