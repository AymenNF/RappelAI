import type { PoolClient } from 'pg';
export const categories = ['late', 'missing', 'wrong', 'confusing', 'good', 'other'] as const;
export type FeedbackCategory = (typeof categories)[number];
export function feedbackCommand(text: string | null): { category: FeedbackCategory | null } | null {
  if (!text || !/^FEEDBACK\b/i.test(text.trim())) return null;
  const found = /^FEEDBACK (LATE|MISSING|WRONG|CONFUSING|GOOD|OTHER)$/i.exec(text.trim());
  return { category: found ? (found[1]!.toLowerCase() as FeedbackCategory) : null };
}
export async function recordFeedback(
  c: PoolClient,
  eventId: string,
  userId: string,
  category: FeedbackCategory | null,
) {
  if (!category)
    return 'Use FEEDBACK LATE, MISSING, WRONG, CONFUSING, GOOD or OTHER. Send one category without private details.';
  const result = await c.query(
    `INSERT INTO beta_feedback(user_id,event_id,category) VALUES($1,$2,$3)
    ON CONFLICT(event_id) DO NOTHING RETURNING id`,
    [userId, eventId, category],
  );
  const id =
    result.rows[0]?.id ??
    (
      await c.query('SELECT id FROM beta_feedback WHERE event_id=$1 AND user_id=$2', [
        eventId,
        userId,
      ])
    ).rows[0]?.id;
  if (!id) throw new Error('Feedback owner mismatch');
  return `Feedback recorded (${category}). Reference: ${id}. This does not change a reminder or confirm delivery. Use its reminder controls for changes.`;
}
