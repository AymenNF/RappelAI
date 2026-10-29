import { randomUUID } from 'node:crypto';

export const CONSENT_VERSION = 'local-development-v1';
export const CONSENT_NOTICE =
  'Local test of Memorae: your WhatsApp identifier, messages and settings are stored in the local database. ' +
  'No AI provider or message sender is connected yet. Use synthetic data only. ' +
  'Reply with the consent command below to test onboarding, or STOP to decline or withdraw. ' +
  'Production requires a new notice naming processors and retention before real users or AI calls.';

export interface IdentityState {
  deletion_requested_at?: Date | null;
  consent_version: string | null;
  consent_at: Date | null;
  consent_token: string | null;
  consent_offer_version: string | null;
  consent_expires_at: Date | null;
  paused: boolean;
  timezone: string | null;
  timezone_confirmed_at: Date | null;
  pending_timezone: string | null;
  timezone_token: string | null;
  timezone_expires_at: Date | null;
  last_control_at: Date | null;
}
export type OnboardingResult = {
  state: IdentityState;
  disposition: 'handled' | 'ready' | 'blocked';
  reply: string | null;
  consentAction: 'accepted' | 'revoked' | null;
};

export function canonicalTimezone(input: string): string | null {
  // Require an explicit IANA area/location (or UTC), not an abbreviation or offset.
  if (input !== 'UTC' && !/^[A-Za-z_+-]+\/[A-Za-z0-9_+\-/]+$/.test(input)) return null;
  try {
    return new Intl.DateTimeFormat('en', { timeZone: input }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function hasOnboarded(state: IdentityState): boolean {
  return (
    !state.deletion_requested_at &&
    !state.paused &&
    state.consent_version === CONSENT_VERSION &&
    !!state.consent_at &&
    !!state.timezone &&
    !!state.timezone_confirmed_at &&
    !state.pending_timezone
  );
}

export function onboard(
  previous: IdentityState,
  text: string | null,
  sentAt: Date,
  now: Date,
  token: () => string = randomUUID,
): OnboardingResult {
  const state = { ...previous };
  const command = text?.trim() ?? '';
  const upper = command.toUpperCase();
  const result = (
    reply: string | null,
    disposition: OnboardingResult['disposition'] = 'handled',
    consentAction: OnboardingResult['consentAction'] = null,
  ): OnboardingResult => ({ state, reply, disposition, consentAction });
  const clearZoneProposal = () => {
    state.pending_timezone = null;
    state.timezone_token = null;
    state.timezone_expires_at = null;
  };
  // Revocation is conservative: even a delayed STOP disables future work.
  if (upper === 'STOP' || upper === 'DECLINE') {
    state.paused = true;
    state.consent_version = null;
    state.consent_at = null;
    state.consent_token = null;
    state.consent_offer_version = null;
    state.consent_expires_at = null;
    clearZoneProposal();
    state.last_control_at = new Date(
      Math.max(sentAt.getTime(), previous.last_control_at?.getTime() ?? 0),
    );
    return result(
      'Paused. Consent withdrawn. No new assistant work will run. Reply START to review consent again.',
      'handled',
      'revoked',
    );
  }
  const isControl = /^(START|CONSENT\b|TIMEZONE\b|CONFIRM TIMEZONE\b)/i.test(command);
  if (isControl && state.last_control_at && sentAt < state.last_control_at) {
    return result(
      'That settings reply is older than your latest change. Please send the command again.',
      'blocked',
    );
  }
  if (state.paused && upper !== 'START') return result(null, 'blocked');
  if (upper === 'START') {
    state.paused = false;
    state.last_control_at = sentAt;
  }
  if (state.consent_version !== CONSENT_VERSION || !state.consent_at) {
    const accepted =
      state.consent_offer_version === CONSENT_VERSION &&
      state.consent_token &&
      state.consent_expires_at &&
      state.consent_expires_at > now &&
      command === `CONSENT ${state.consent_token}`;
    if (!accepted) {
      if (
        state.consent_offer_version !== CONSENT_VERSION ||
        !state.consent_token ||
        !state.consent_expires_at ||
        state.consent_expires_at <= now
      ) {
        state.consent_token = token();
        state.consent_offer_version = CONSENT_VERSION;
        state.consent_expires_at = new Date(now.getTime() + 86400000);
      }
      return result(
        `${CONSENT_NOTICE}\nNotice: ${CONSENT_VERSION}\nCONSENT ${state.consent_token}`,
      );
    }
    state.consent_version = CONSENT_VERSION;
    state.consent_at = now;
    state.consent_token = null;
    state.consent_offer_version = null;
    state.consent_expires_at = null;
    state.last_control_at = sentAt;
    return result(
      'Consent recorded for this local test. Choose your timezone: TIMEZONE America/Toronto (or another IANA zone, such as Europe/Paris or UTC).',
      'handled',
      'accepted',
    );
  }
  if (command.startsWith('CONFIRM TIMEZONE ')) {
    if (
      !state.timezone_token ||
      command !== `CONFIRM TIMEZONE ${state.timezone_token}` ||
      !state.pending_timezone ||
      !state.timezone_expires_at ||
      state.timezone_expires_at <= now
    ) {
      return result(
        'That timezone confirmation is invalid or expired. Send TIMEZONE followed by your IANA zone.',
        'blocked',
      );
    }
    state.timezone = state.pending_timezone;
    state.timezone_confirmed_at = now;
    clearZoneProposal();
    state.last_control_at = sentAt;
    return result(
      `Timezone confirmed: ${state.timezone}. Onboarding is complete. Reminder processing is not connected yet.`,
    );
  }
  if (/^TIMEZONE\b/i.test(command)) {
    const zone = canonicalTimezone(command.slice(8).trim());
    if (!zone)
      return result(
        'Use an IANA timezone such as America/Toronto, Europe/Paris, or UTC. Abbreviations such as EST are ambiguous.',
        'blocked',
      );
    state.pending_timezone = zone;
    state.timezone_token = token();
    state.timezone_expires_at = new Date(now.getTime() + 900000);
    state.last_control_at = sentAt;
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(now);
    return result(
      `Your local time in ${zone} is ${local}. Confirm with: CONFIRM TIMEZONE ${state.timezone_token}`,
    );
  }
  if (!hasOnboarded(state))
    return result(
      'Please choose and confirm your timezone first: TIMEZONE America/Toronto (replace with your zone).',
    );
  if (state.consent_at && sentAt.getTime() < Math.floor(state.consent_at.getTime() / 1000) * 1000) {
    return result(
      'That message predates your current consent. Please send the request again.',
      'blocked',
    );
  }
  if (!text) return result('This local version supports text messages only.', 'blocked');
  return result(null, 'ready');
}
